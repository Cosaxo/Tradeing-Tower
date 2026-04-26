// Three-tier epoch loop.
//
//  Fast   (FAST_MS  ≈ 1 s): advance prices, safety barrier check per pair
//  Medium (MEDIUM_MS ≈ 6 s): run auctions, settle pools, update NPCs, contracts
//  Slow   (every SLOW_EVERY medium ticks): analytics, insurance pool, regime, correlation

import { useEffect, useRef, useCallback } from "react";
import { FAST_MS, MEDIUM_MS, SLOW_EVERY, INSURANCE_EVERY, GRACE_MS, SOFT_CLOSE_PCT } from "../constants/system.js";
import { priceStep } from "../lib/priceModels.js";
import { calcRealizedSigma, calcRatioBeta as calcRatioBetaStat, ratioEffectiveSigma } from "../lib/math.js";
import { detectRegime } from "../lib/regime.js";
import { updateNpcRegime, applyNpcSettlement, tickNpcRestock, isNpcActive } from "../lib/npcs.js";
import { runAuction } from "../lib/auction.js";
import { settleDominantPool, calcRatioBeta, escrowTips } from "../lib/pool.js";
import { settleStrips } from "../lib/strips.js";
import { settleInsurancePool } from "../lib/insurance.js";
import { updateYieldModel, calcYieldBufferContribution } from "../lib/yieldModel.js";
import { calcCrossMarketCorrelations } from "../lib/correlation.js";
import { generateNpcOrders } from "../lib/npcMarkets.js";
import { matchRentalAuction, settleRentals } from "../lib/rentalMarket.js";
import { isPairedLap } from "../lib/pairedLap.js";
import { appendEpochEntry } from "../lib/roleLedger.js";
import { normalizeTags } from "../lib/capitalTags.js";
import { checkConservation, formatConservationLog } from "../lib/conservation.js";
import { TBILL_RATE } from "../constants/system.js";
import { pushPrice } from "../state/pairState.js";
import { getEffectiveCap } from "../lib/esma.js";
import { ACTIVE_PAIRS } from "../constants/assets.js";

export function useEpochLoop({
  pairStates: _pairStates, // reserved for future read-only access
  setPairStates,    // React setter
  player,           // { id, leverage, margin, side, strategy, minYield, tip_tiers, ... }
  setPlayer,        // React setter
  openPositions = [], // current player positions — used to look up paired LAPs by id during rental settlement
  setLogs,          // (fn) => void
  addToast,         // (msg, type) => void
  running,          // boolean
  speed = 1,        // multiplier: 0.5x, 1x, 2x, 5x
  setRoleLedger,    // setter for per-role attribution ledger
}) {
  const mediumCountRef = useRef(0);
  const lastPlayerEditRef = useRef(0);
  // Latest player positions, threaded via ref so the medium-tick
  // callback doesn't have to recreate on every position change.
  const openPositionsRef = useRef(openPositions);
  openPositionsRef.current = openPositions;

  // Signal that the player config was just changed.
  const onPlayerEdit = useCallback(() => {
    lastPlayerEditRef.current = Date.now();
  }, []);

  // -------------------------------------------------------------------------
  // Fast tick: advance price + barrier check only
  // -------------------------------------------------------------------------
  const fastTick = useCallback(() => {
    setPairStates((prev) => {
      const next = { ...prev };
      ACTIVE_PAIRS.forEach((pk) => {
        const ps = prev[pk];
        if (!ps) return;
        const prices = ps.prices;
        const latestPrice = prices[prices.length - 1];
        const newPrice = priceStep(ps.pair, latestPrice, ps.realizedSigma);
        const updated = pushPrice(ps, newPrice);
        const newSigma = calcRealizedSigma(updated.prices, 12);
        next[pk] = { ...updated, realizedSigma: newSigma };
      });
      return next;
    });
  }, [setPairStates]);

  // -------------------------------------------------------------------------
  // Medium tick: auction + settlement
  // -------------------------------------------------------------------------
  const mediumTick = useCallback(() => {
    const now = Date.now();
    // Soft-close (§2.2): bids amended within the last SOFT_CLOSE_PCT of the epoch
    // are frozen out. GRACE_MS handles per-edit settling; soft-close handles the
    // intra-epoch bid-freeze window.
    const gracePeriod = now - lastPlayerEditRef.current < GRACE_MS;
    const softCloseWindowMs = MEDIUM_MS * (1 - SOFT_CLOSE_PCT);
    const timeSinceLastEdit = now - lastPlayerEditRef.current;
    const inSoftClose =
      timeSinceLastEdit < softCloseWindowMs && timeSinceLastEdit >= GRACE_MS;
    const bidsFrozen = gracePeriod || inSoftClose;
    mediumCountRef.current += 1;
    const doSlow = mediumCountRef.current % SLOW_EVERY === 0;
    // Insurance runs on its own prime stride (INSURANCE_EVERY). Coprime
    // with SLOW_EVERY so the two settlements never coincide — analytics
    // and insurance never mutate overlapping state in the same frame.
    const doInsurance = mediumCountRef.current % INSURANCE_EVERY === 0;

    setPairStates((prev) => {
      const logs = [];
      const next = { ...prev };

      // Collect all price histories for cross-market correlation (slow only).
      const priceHistories = {};
      ACTIVE_PAIRS.forEach((pk) => {
        if (prev[pk]) priceHistories[pk] = prev[pk].prices;
      });
      const corrMap = doSlow ? calcCrossMarketCorrelations(priceHistories) : {};

      // --- Collect all auction results for insurance pool (slow only) ---
      const allPairAuctions = {};

      ACTIVE_PAIRS.forEach((pk) => {
        const ps = prev[pk];
        if (!ps) return;

        const { prices, realizedSigma, npcs, regime, yieldModel,
                smileParams, metaParams, prevSmoothFills, alpha,
                strips,
                insurancePool, epochIndex, yieldBuffer = 0,
                yieldBufferEpochs = 0, regimeHistory = [],
                rentalOffers = [], rentalBids = [], activeRentals = [],
                feeLedger = {} } = ps;

        const priceOld = prices[prices.length - 2] ?? prices[prices.length - 1];
        const priceNew = prices[prices.length - 1];

        // Regime detection on slow tick only.
        const updatedRegime = doSlow ? detectRegime(ps.returnHistory) : (regime ?? { key: "CALM" });
        const prevRegimeKey = regime?.key;
        const regimeShifted = doSlow && updatedRegime.key !== prevRegimeKey;
        const newRegimeHistory = regimeShifted
          ? [...regimeHistory.slice(-99), { epoch: epochIndex, ...updatedRegime }]
          : regimeHistory;
        if (regimeShifted) {
          logs.push(`[REGIME] ${pk}: ${prevRegimeKey ?? "-"} → ${updatedRegime.key}`);
        }

        // Update NPCs with regime awareness, then tick restock cooldowns.
        const regimeUpdatedNpcs = npcs.map((npc) =>
          updateNpcRegime(npc, prices.slice(-20), updatedRegime, null, yieldModel)
        );
        const restockedNpcs = tickNpcRestock(regimeUpdatedNpcs);
        const justRestocked = restockedNpcs.filter(
          (n, i) => (regimeUpdatedNpcs[i].restockRemaining ?? 0) === 1 && (n.restockRemaining ?? 0) === 0
        );
        justRestocked.forEach((n) => logs.push(`[NPC] ${n.id} restocked to $${n.base_margin}`));

        // Only NPCs with margin + not in cooldown participate in the auction.
        const activeNpcs = restockedNpcs.filter(isNpcActive);

        // Build participants: active NPCs + player (if not in grace period).
        const { effectiveCap: cap } = getEffectiveCap(pk, realizedSigma);
        const participants = activeNpcs.map((n) => ({
          ...n,
          base_margin: n.current_margin ?? n.base_margin,
        }));
        if (!bidsFrozen && player && player.activePair === pk) {
          participants.push({
            ...player,
            max_lev: Math.min(player.leverage ?? 1, cap),
          });
        }

        // Run auction.
        const auctionResult = runAuction(
          participants,
          alpha,
          logs,
          cap,
          smileParams,
          realizedSigma,
          prevSmoothFills,
          metaParams
        );
        allPairAuctions[pk] = auctionResult;

        // Settle dominant pool.
        const longMargin = auctionResult.matched
          .filter((m) => m.longId)
          .reduce((s, m) => s + m.margin, 0);
        const shortMargin = auctionResult.matched
          .filter((m) => m.shortId)
          .reduce((s, m) => s + m.margin, 0);
        const newAlpha = calcRatioBeta(longMargin, shortMargin);

        // Ratio-correlated effective sigma (§4.6).
        const ratioRaw = shortMargin > 0 ? longMargin / shortMargin : (longMargin > 0 ? 10 : 1);
        const newRatioHistory = [...(ps.ratioHistory ?? []).slice(-99), ratioRaw];
        const ratioBeta = calcRatioBetaStat(newRatioHistory, ps.returnHistory);
        const effectiveSigma = ratioEffectiveSigma(realizedSigma, ratioRaw, ratioBeta);

        // Build user list for pool settlement (active NPC + player positions).
        const poolUsers = activeNpcs.map((npc) => ({
          id: npc.id,
          margin: npc.current_margin ?? npc.base_margin,
          leverage: Math.min(npc.max_lev, cap),
          side: npc.strategy?.includes("SHORT") ? "SHORT" : "LONG",
          active: true,
        }));
        if (!bidsFrozen && player?.activePair === pk) {
          poolUsers.push({
            id: player.id ?? "You",
            margin: player.margin ?? 5000,
            leverage: Math.min(player.leverage ?? 1, cap),
            side: player.side ?? "LONG",
            active: true,
          });
        }

        const { users: settledUsers, stabilityFeeCollected, logs: poolLogs } =
          settleDominantPool(poolUsers, priceOld, priceNew, effectiveSigma, corrMap);
        poolLogs.forEach((l) => logs.push(l));

        // Write NPC settlement margins back — track liquidations + schedule restock.
        const updatedNpcs = applyNpcSettlement(restockedNpcs, settledUsers);
        const deadThisEpoch = updatedNpcs.filter(
          (n, i) => (restockedNpcs[i].current_margin ?? restockedNpcs[i].base_margin) > 0 && n.current_margin === 0
        );
        deadThisEpoch.forEach((n) =>
          logs.push(`[NPC] ${n.id} liquidated — restock in ${n.restockRemaining} epochs`)
        );

        // Update player margin if this is their active pair.
        // Decompose settlement into T-bill + auction P&L + tips (§4.10).
        let playerRoleEntry = null;
        if (!bidsFrozen && player?.activePair === pk) {
          const playerSettled = settledUsers.find((u) => u.id === (player.id ?? "You"));
          if (playerSettled) {
            const preMargin = player.margin ?? 0;
            const postMargin = playerSettled.margin;
            // Pool applies T-bill multiplicatively AFTER geometric P&L + stability fee.
            // tbill portion = postMargin − postMargin / (1 + r).
            const r = TBILL_RATE / 365;
            const tbill = playerSettled.active ? postMargin - postMargin / (1 + r) : 0;
            const auctionPnl = playerSettled.active
              ? postMargin / (1 + r) - preMargin
              : postMargin - preMargin;

            // Tips are escrowed separately (§5.2) — use the escrow, not raw matches.
            const pid = player.id ?? "You";
            const { tipEscrow } = escrowTips(auctionResult.matched);
            const tipEntry = tipEscrow[pid] ?? { paid: 0, received: 0 };
            const tips = tipEntry.received - tipEntry.paid;

            playerRoleEntry = {
              epoch: epochIndex,
              tbill,
              auctionPnl,
              tips,
              // poolYield + stripPnl + creditChange filled in below as we settle.
              poolYield: 0,
              stripPnl: 0,
              creditChange: 0,
            };

            setPlayer((prev) => ({
              ...prev,
              margin: playerSettled.margin,
              pnl: playerSettled.pnl ?? 0,
              liquidated: playerSettled.liquidated,
              // If margin fell below tagged total, shrink tags proportionally (§10.1).
              tags: normalizeTags(playerSettled.margin, prev.tags ?? {}),
            }));
            if (playerSettled.liquidated) {
              addToast(`Liquidated on ${pk}!`, "error");
            }
          }
        }

        // NPC market participation: strip buys + rental bids on paired-LAP legs.
        const npcOrders = generateNpcOrders({
          npcs: updatedNpcs.filter(isNpcActive),
          longMargin,
          shortMargin,
          regime: updatedRegime,
          normWeights: auctionResult.normWeights ?? [],
          realizedSigma,
          returnHistory: ps.returnHistory,
          epochIndex,
          pairKey: pk,
          legNotionalEstimate: 1000,
        });

        const pid = player?.id ?? "You";

        // Settle strips (including fresh NPC strip buys).
        const currentYield = auctionResult.matched.length > 0
          ? auctionResult.matched.reduce((s, m) => s + m.longTip, 0) / auctionResult.matched.length
          : 0;
        const playerMarginForStrips = player?.activePair === pk ? (player.margin ?? 5000) : 0;
        const stripsWithNpcs = [...strips, ...npcOrders.stripBuys];
        const { settled: stripsSettled, totalPremiumCollected, logs: stripsLogs } =
          settleStrips(stripsWithNpcs, currentYield, realizedSigma, ps.returnHistory, playerMarginForStrips);
        stripsLogs.forEach((l) => logs.push(l));

        // Strip payouts flow back to the buyer's margin (Floor 4 §4.10).
        let playerStripPnl = 0;
        for (const s of stripsSettled) {
          if (s.buyerId === pid && s.lastPayout) playerStripPnl += s.lastPayout;
        }
        if (playerStripPnl !== 0 && player?.activePair === pk) {
          setPlayer((prev) => ({ ...prev, margin: (prev.margin ?? 0) + playerStripPnl }));
          if (playerRoleEntry) playerRoleEntry.stripPnl =
            (playerRoleEntry.stripPnl ?? 0) + playerStripPnl;
        }
        if (npcOrders.stripBuys.length > 0) {
          logs.push(`[NPC-STRIP] ${npcOrders.stripBuys.length} new strips`);
        }

        // Update insurance pool pending premiums.
        let nextPool = {
          ...insurancePool,
          pendingPremiums: insurancePool.pendingPremiums + totalPremiumCollected + stabilityFeeCollected,
          pendingStabilityFee: 0,
        };

        // Insurance settles on its own prime-stride cadence (INSURANCE_EVERY),
        // deliberately decoupled from the analytics slow tick. Rarer + chunkier
        // yield is more predictable for depositors; the coprime stride
        // guarantees insurance and analytics never settle in the same frame.
        let slowLogs = [];
        let poolFlow = null;
        if (doInsurance) {
          const playerPid = player?.id ?? "You";
          const preDeposit = insurancePool.deposits?.[playerPid]?.amount ?? 0;
          const { pool: settledPool, log, flow } = settleInsurancePool(
            nextPool, allPairAuctions, epochIndex
          );
          nextPool = settledPool;
          slowLogs = log;
          poolFlow = flow;
          // Attribute the player's pool yield slice (Floor 1, §4.10).
          const postDeposit = settledPool.deposits?.[playerPid]?.amount ?? 0;
          const delta = postDeposit - preDeposit;
          if (playerRoleEntry) playerRoleEntry.poolYield = delta;
        }

        const updatedYieldModel = updateYieldModel(yieldModel, currentYield);

        // Yield buffer: skim excess into reserve, draw from reserve on pool shortfall.
        const bufferContrib = calcYieldBufferContribution(currentYield, yieldBufferEpochs, yieldBuffer);
        let newYieldBuffer = yieldBuffer + bufferContrib;

        // If pool had unmet claims this epoch, draw from buffer to subsidise.
        const unmet = nextPool.pendingClaims ?? 0;
        let bufferDraw = 0;
        if (unmet > 0 && newYieldBuffer > 0) {
          bufferDraw = Math.min(unmet, newYieldBuffer);
          newYieldBuffer -= bufferDraw;
          nextPool = {
            ...nextPool,
            pendingClaims: Math.max(0, unmet - bufferDraw),
          };
          logs.push(
            `[BUFFER DRAW] ${pk}: drew $${bufferDraw.toFixed(2)} to cover pool shortfall (${unmet.toFixed(2)} unmet)`
          );
        }

        // Fee ledger: tally the epoch's flows (stabilityFee + stripPremium are
        // the only inbound revenue streams remaining after the contract and
        // lending market cuts).
        const epochFlow = {
          stabilityFee: stabilityFeeCollected,
          stripPremium: totalPremiumCollected,
          routedToBuffer: bufferContrib,
          routedToPool: stabilityFeeCollected + totalPremiumCollected,
          routedToDepositors: poolFlow?.netDistrib ?? 0,
          claimsPaid: poolFlow?.claimsPaid ?? 0,
          bufferDraws: bufferDraw,
        };
        const newFeeLedger = {
          stabilityFee: (feeLedger.stabilityFee ?? 0) + epochFlow.stabilityFee,
          stripPremium: (feeLedger.stripPremium ?? 0) + epochFlow.stripPremium,
          routedToBuffer: (feeLedger.routedToBuffer ?? 0) + epochFlow.routedToBuffer,
          routedToPool: (feeLedger.routedToPool ?? 0) + epochFlow.routedToPool,
          routedToDepositors:
            (feeLedger.routedToDepositors ?? 0) + epochFlow.routedToDepositors,
          claimsPaid: (feeLedger.claimsPaid ?? 0) + epochFlow.claimsPaid,
          bufferDraws: (feeLedger.bufferDraws ?? 0) + epochFlow.bufferDraws,
          lastEpoch: epochFlow,
        };

        // §9 conservation assertion — verify pool identity each epoch.
        const tipsEscrowed = auctionResult.matched.reduce(
          (s, m) => s + (m.margin ?? 0) * ((m.longTip ?? 0) + (m.shortTip ?? 0)),
          0
        );
        const conservation = checkConservation({
          totalIn: epochFlow.stabilityFee + epochFlow.stripPremium,
          totalOut: epochFlow.routedToDepositors + epochFlow.claimsPaid,
          tipsEscrowed,
          totalPoolDeposit: nextPool.totalDeposits ?? 0,
        });
        if (conservation.violated) {
          logs.push(formatConservationLog(pk, conservation));
        }

        // Event log for annotations.
        const newEvents = [...(ps.events ?? [])];
        if (regimeShifted) {
          newEvents.push({ epoch: epochIndex, type: "regime", meta: updatedRegime });
        }
        if (auctionResult.softClose) {
          newEvents.push({ epoch: epochIndex, type: "softClose" });
        }
        const liqThisEpoch = settledUsers.filter((u) => u.liquidated).length;
        if (liqThisEpoch > 0) {
          newEvents.push({ epoch: epochIndex, type: "liquidation", meta: { count: liqThisEpoch } });
        }

        // -------------------------------------------------------------------
        // Rental market (Phase 3)
        //
        // 1. Settle existing rentals one tick (P&L flows to renter,
        //    tip flows to owner, defaults / expirations terminate).
        // 2. Match the order book — owner offers + NPC bids — and append
        //    new rentals.
        // -------------------------------------------------------------------
        const findPairedLap = (id) => {
          const positions = openPositionsRef.current ?? [];
          const found = positions.find((p) => isPairedLap(p) && p.id === id);
          return found ?? null;
        };
        const rentalSettle = settleRentals({
          activeRentals,
          findPairedLap,
          priceOld,
          priceNew,
          currentEpoch: epochIndex,
        });
        rentalSettle.logs.forEach((l) => logs.push(l));

        // Owner-tip income flushed to player margin if the owner is the
        // local player. (NPC-owned rentals don't exist yet in Phase 3,
        // so this is the only counterparty handled.)
        const ownerCredits = rentalSettle.ownerCredits ?? {};
        const playerOwnerCredit = ownerCredits[pid] ?? 0;
        if (playerOwnerCredit > 0) {
          setPlayer((prev) => ({
            ...prev,
            margin: (prev.margin ?? 0) + playerOwnerCredit,
          }));
        }

        // Match the orderbook against newly-arrived NPC bids.
        const offersBeforeMatch = rentalOffers;
        const bidsBeforeMatch = [...rentalBids, ...(npcOrders.rentalBids ?? [])];
        const rentalMatch = matchRentalAuction({
          offers: offersBeforeMatch,
          bids: bidsBeforeMatch,
          currentEpoch: epochIndex,
        });
        rentalMatch.logs.forEach((l) => logs.push(l));

        const nextRentalOffers = rentalMatch.remainingOffers;
        const nextRentalBids = rentalMatch.remainingBids;
        const nextActiveRentals = [...rentalSettle.rentals, ...rentalMatch.newRentals];

        next[pk] = {
          ...ps,
          npcs: updatedNpcs,
          regime: updatedRegime,
          regimeHistory: newRegimeHistory,
          events: newEvents.slice(-80),
          auctionResult,
          smileParams: auctionResult.smileParams,
          metaParams: auctionResult.metaParams,
          prevSmoothFills: auctionResult.smoothFills,
          alpha: newAlpha,
          strips: stripsSettled,
          insurancePool: nextPool,
          yieldModel: updatedYieldModel,
          yieldBuffer: newYieldBuffer,
          yieldBufferEpochs: yieldBufferEpochs + 1,
          feeLedger: newFeeLedger,
          rentalOffers: nextRentalOffers,
          rentalBids: nextRentalBids,
          activeRentals: nextActiveRentals,
          epochIndex: epochIndex + 1,
          correlationMap: doSlow ? corrMap : ps.correlationMap,
          currentYield,
          ratioHistory: newRatioHistory,
          effectiveSigma,
          ratioBeta,
        };

        if (slowLogs.length > 0) slowLogs.forEach((l) => logs.push(l));

        // Post the player's per-role ledger entry for this epoch.
        if (playerRoleEntry && setRoleLedger) {
          setRoleLedger((prev) => appendEpochEntry(prev, playerRoleEntry));
        }
      });

      if (logs.length > 0) {
        setLogs((prev) => [...prev.slice(-300), ...logs]);
      }

      return next;
    });
  }, [setPairStates, player, setPlayer, setLogs, addToast, setRoleLedger]);

  // -------------------------------------------------------------------------
  // Interval management
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!running) return;
    const mult = speed > 0 ? speed : 1;

    const fastId = setInterval(fastTick, FAST_MS / mult);
    const medId = setInterval(mediumTick, MEDIUM_MS / mult);

    return () => {
      clearInterval(fastId);
      clearInterval(medId);
    };
  }, [running, fastTick, mediumTick, speed]);

  return { onPlayerEdit };
}
