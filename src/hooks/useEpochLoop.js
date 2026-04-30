// Three-tier epoch loop.
//
//  Fast   (FAST_MS  ≈ 1 s): advance prices, safety barrier check per pair
//  Medium (MEDIUM_MS ≈ 6 s): run auctions, settle pools, update NPCs, contracts
//  Slow   (every SLOW_EVERY medium ticks): analytics, insurance pool, regime, correlation

import { useEffect, useRef, useCallback } from "react";
import { FAST_MS, MEDIUM_MS, SLOW_EVERY, REDEMPTION_EVERY, GRACE_MS, SOFT_CLOSE_PCT } from "../constants/system.js";
import { priceStep } from "../lib/priceModels.js";
import { calcRealizedSigma, calcRatioBeta as calcRatioBetaStat, ratioEffectiveSigma } from "../lib/math.js";
import { detectRegime } from "../lib/regime.js";
import { updateNpcRegime, applyNpcSettlement, tickNpcRestock, isNpcActive } from "../lib/npcs.js";
import { runAuction } from "../lib/auction.js";
import { settleDominantPool, calcRatioBeta, escrowTips } from "../lib/pool.js";
import { updateYieldModel } from "../lib/yieldModel.js";
import { calcCrossMarketCorrelations } from "../lib/correlation.js";
import { generateNpcOrders } from "../lib/npcMarkets.js";
import { matchRentalAuction, settleRentals } from "../lib/rentalMarket.js";
import { isPairedLap } from "../lib/pairedLap.js";
import {
  runRedemptionCycle,
  applySolvencyCheck,
  submitRedemption as submitTtRedemption,
} from "../lib/towerTether.js";
import { detectTriggeredEvents } from "../lib/insuranceEvents.js";
import { settleMarketTick, withdrawInsurer } from "../lib/insuranceMarket.js";
import { settleReinsuranceTick } from "../lib/reinsurance.js";
import { calcAllocationLtv } from "../lib/ltv.js";
import { allocationDiversificationStats } from "../lib/allocations.js";
import { appendEpochEntry } from "../lib/roleLedger.js";
import { normalizeTags } from "../lib/capitalTags.js";
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
  ttState = null,   // Tower Tether global state (mints, balances, queue, etc.)
  setTtState,       // React setter for TT state
  insuranceState = null, // global insurance markets + reinsurance + allocations
  setInsuranceState,     // React setter for insuranceState
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
  // Same trick for ttState so the loop can read the latest snapshot
  // without re-creating on every mint/transfer.
  const ttStateRef = useRef(ttState);
  ttStateRef.current = ttState;
  // And for insuranceState — the medium-tick block reads + writes a
  // working copy across the per-pair forEach + the redemption-cycle
  // block, so we need the freshest snapshot each tick.
  const insuranceStateRef = useRef(insuranceState);
  insuranceStateRef.current = insuranceState;

  // Helper: pick a representative epoch from the pair-states object.
  // Used by the TT redemption cycle which is global, not per-pair.
  function epochOfFirstPair(pairStatesObj) {
    for (const pk of ACTIVE_PAIRS) {
      if (pairStatesObj[pk]?.epochIndex != null) {
        return pairStatesObj[pk].epochIndex;
      }
    }
    return 0;
  }

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

    setPairStates((prev) => {
      const logs = [];
      const next = { ...prev };

      // Collect all price histories for cross-market correlation (slow only).
      const priceHistories = {};
      ACTIVE_PAIRS.forEach((pk) => {
        if (prev[pk]) priceHistories[pk] = prev[pk].prices;
      });
      const corrMap = doSlow ? calcCrossMarketCorrelations(priceHistories) : {};

      ACTIVE_PAIRS.forEach((pk) => {
        const ps = prev[pk];
        if (!ps) return;

        const { prices, realizedSigma, npcs, regime, yieldModel,
                smileParams, metaParams, prevSmoothFills, alpha,
                epochIndex, regimeHistory = [],
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

        const pid = player?.id ?? "You";

        // NPC market participation: rental bids on paired-LAP legs.
        // (Strip buys were removed in Phase 5.)
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

        // Auction tip-rate proxy used by the yield model.
        const currentYield = auctionResult.matched.length > 0
          ? auctionResult.matched.reduce((s, m) => s + m.longTip, 0) / auctionResult.matched.length
          : 0;

        const updatedYieldModel = updateYieldModel(yieldModel, currentYield);

        // Fee ledger: only stability fee remains as a per-pair inbound
        // stream after the Phase-5 cut. The (now global) insurance and
        // reinsurance markets keep their own bookkeeping in
        // insuranceState; nothing per-pair flows out of the auction.
        const epochFlow = {
          stabilityFee: stabilityFeeCollected,
        };
        const newFeeLedger = {
          stabilityFee: (feeLedger.stabilityFee ?? 0) + stabilityFeeCollected,
          lastEpoch: epochFlow,
        };

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
          yieldModel: updatedYieldModel,
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

        // Post the player's per-role ledger entry for this epoch.
        if (playerRoleEntry && setRoleLedger) {
          setRoleLedger((prev) => appendEpochEntry(prev, playerRoleEntry));
        }
      });

      // -----------------------------------------------------------------
      // Global insurance + reinsurance settlement (Phase 5)
      //
      // Insurance markets settle every medium tick (no rare-stride
      // delay; payouts and premium streams are tied to per-tick event
      // detection). For each market: detect whether its event triggered
      // given the freshly-updated per-pair state, then settle via
      // settleMarketTick. Aggregate buyer-side claim outflows into the
      // reinsurance settlement so a TT-minter who got hit on insurance
      // recovers the corresponding fraction from reinsurance buyers.
      //
      // All cash flows (premium in/out, claim in/out, reinsurance
      // payouts/seller losses) are aggregated on a per-user basis and
      // applied to the local player's margin at the end.
      // -----------------------------------------------------------------
      if (insuranceStateRef.current && setInsuranceState) {
        const pid = player?.id ?? "You";
        const tickEpoch = epochOfFirstPair(next);
        // Pull the active pair's correlation map as the cross-pair
        // proxy (the slow-tick recompute already wrote it on the
        // active pair). Fallback to {} on first-tick.
        const activePk = player?.activePair ?? ACTIVE_PAIRS[0];
        const correlationMap = next[activePk]?.correlationMap ?? {};
        const ctx = {
          pairStates: next,
          // No system-solvency input wired into the hook yet; default 1
          // (high) so the macro detector won't fire spuriously here.
          solvencyBuffer: 1,
          correlationMap,
          currentEpoch: tickEpoch,
        };
        const triggered = detectTriggeredEvents(ctx);

        let nextInsurance = { ...insuranceStateRef.current };
        const buyerLossesByUser = {};
        const playerCashChanges = {};

        nextInsurance.markets = nextInsurance.markets.map((m) => {
          const eventTriggered = triggered.includes(m.eventId);
          const r = settleMarketTick({
            market: m,
            eventTriggered,
            currentEpoch: tickEpoch,
          });
          r.logs.forEach((l) => logs.push(l));
          for (const [uid, v] of Object.entries(r.premiumIn)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) + v;
          }
          for (const [uid, v] of Object.entries(r.premiumOut)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) - v;
          }
          for (const [uid, v] of Object.entries(r.claimIn)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) + v;
          }
          for (const [uid, v] of Object.entries(r.claimOut)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) - v;
            buyerLossesByUser[uid] = (buyerLossesByUser[uid] ?? 0) + v;
          }
          return r.market;
        });

        nextInsurance.reinsurance = nextInsurance.reinsurance.map((p) => {
          const r = settleReinsuranceTick({
            product: p,
            buyerLossesByUser,
            currentEpoch: tickEpoch,
          });
          r.logs.forEach((l) => logs.push(l));
          for (const [uid, v] of Object.entries(r.payouts)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) + v;
          }
          for (const [uid, v] of Object.entries(r.sellerLosses)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) - v;
          }
          for (const [uid, v] of Object.entries(r.premiumIn)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) + v;
          }
          for (const [uid, v] of Object.entries(r.premiumOut)) {
            playerCashChanges[uid] = (playerCashChanges[uid] ?? 0) - v;
          }
          return r.product;
        });

        setInsuranceState(nextInsurance);
        // Persist the working copy for downstream blocks (redemption
        // haircut application reads it via the ref).
        insuranceStateRef.current = nextInsurance;

        const playerNet = playerCashChanges[pid] ?? 0;
        if (playerNet !== 0) {
          setPlayer((prev) => ({ ...prev, margin: (prev.margin ?? 0) + playerNet }));
        }
      }

      // -----------------------------------------------------------------
      // Tower Tether redemption cycle (Phase 4)
      //
      // Runs on its own prime stride (REDEMPTION_EVERY) coprime with
      // analytics + insurance, ~monthly in sim-days. On each cycle:
      //   1. Merchant simulator queues 50% of its TT balance for
      //      standard redemption — creates organic queue pressure.
      //   2. runRedemptionCycle drains express + standard requests up to
      //      the 10% cap; computes pro-rata collateral haircut by minter.
      //   3. Apply the haircut to each minter's allocations (insurer-side
      //      stakes across the insurance markets). The reduction is
      //      pro-rata across whichever markets they hold a stake in.
      //   4. Pay out dollars to each redeemer's main margin (cash flow).
      //   5. Recheck solvency for each affected minter — if their
      //      outstanding mint exceeds the new cap, claw back from
      //      wallet TT first, then record any remaining shortfall as
      //      debt.
      // -----------------------------------------------------------------
      if (mediumCountRef.current % REDEMPTION_EVERY === 0 && setTtState && ttStateRef.current) {
        const tickEpoch = epochOfFirstPair(next);
        let workingTt = ttStateRef.current;
        let workingInsurance = insuranceStateRef.current;

        // Step 1: merchant auto-redemption — 50% of merchant balance
        // each cycle, standard tier.
        if ((workingTt.merchantBalance ?? 0) > 1) {
          const merchantRedeem = workingTt.merchantBalance * 0.5;
          const submitted = submitTtRedemption({
            ttState: workingTt,
            userId: "MERCHANT",
            amount: merchantRedeem,
            express: false,
            currentEpoch: tickEpoch,
          });
          if (submitted.ok) {
            workingTt = submitted.ttState;
            logs.push(
              `[MERCHANT] queued ${merchantRedeem.toFixed(2)} TT for redemption`
            );
          }
        }

        // Step 2: drain the queue.
        const cycle = runRedemptionCycle({
          ttState: workingTt,
          currentEpoch: tickEpoch,
        });
        cycle.logs.forEach((l) => logs.push(l));
        workingTt = cycle.ttState;

        // Step 3: apply collateral haircuts pro-rata across each
        // minter's allocation stakes.
        const haircuts = cycle.collateralHaircuts;
        if (workingInsurance && Object.keys(haircuts).length > 0) {
          let nextMarkets = workingInsurance.markets;
          for (const minterId of Object.keys(haircuts)) {
            const totalToRemove = haircuts[minterId];
            if (totalToRemove <= 0) continue;
            // Sum the minter's stake across all markets.
            let minterStakeTotal = 0;
            for (const m of nextMarkets) {
              minterStakeTotal += m.insurerPositions?.[minterId] ?? 0;
            }
            if (minterStakeTotal <= 0) continue;
            // Pro-rata reduce each market stake.
            nextMarkets = nextMarkets.map((m) => {
              const stake = m.insurerPositions?.[minterId] ?? 0;
              if (stake <= 0) return m;
              const share = stake / minterStakeTotal;
              const cut = Math.min(stake, totalToRemove * share);
              if (cut <= 1e-9) return m;
              const r = withdrawInsurer({ market: m, userId: minterId, amount: cut });
              return r.ok ? r.market : m;
            });
          }
          workingInsurance = { ...workingInsurance, markets: nextMarkets };
        }

        // Step 4: route the express penalty. The new system has no
        // single "pool" target for this; ideally it would feed the
        // reinsurance sellers. For now we just log and drop it —
        // distributing across products requires a clean injection
        // helper we don't have yet.
        if (cycle.penaltyToPool > 0) {
          logs.push(
            `[TT-PENALTY] $${cycle.penaltyToPool.toFixed(2)} express penalty (no target — see Phase 5 backlog)`
          );
        }

        // Step 5: pay redemption dollars out to each holder's margin.
        // Only the local player and the merchant matter here; merchant
        // dollars stay in the merchant abstraction (ignored for now).
        const playerDollars = cycle.dollarsOut[player?.id] ?? 0;
        if (playerDollars > 0) {
          setPlayer((prev) => ({
            ...prev,
            margin: (prev.margin ?? 0) + playerDollars,
          }));
        }

        // Step 6: solvency recheck per affected minter.
        for (const minterId of Object.keys(haircuts)) {
          // newTotalStake comes from the freshly-haircut allocation
          // markets. LTV is derived from the minter's diversification
          // across those markets.
          const stats = workingInsurance
            ? allocationDiversificationStats({ markets: workingInsurance.markets, userId: minterId })
            : { totalStake: 0 };
          const newTotalStake = stats.totalStake;
          let ltv = 1;
          if (workingInsurance) {
            ltv = calcAllocationLtv({
              markets: workingInsurance.markets,
              userId: minterId,
            }).ltv;
          }
          const solvency = applySolvencyCheck({
            ttState: workingTt,
            userId: minterId,
            newTotalStake,
            ltv,
          });
          workingTt = solvency.ttState;
          if (solvency.clawback > 0 || solvency.newDebt > 0) {
            logs.push(
              `[TT-SOLVENCY] ${minterId} clawback ${solvency.clawback.toFixed(2)} TT, debt +${solvency.newDebt.toFixed(2)}`
            );
          }
        }

        setTtState(workingTt);
        if (workingInsurance && workingInsurance !== insuranceStateRef.current) {
          setInsuranceState(workingInsurance);
          insuranceStateRef.current = workingInsurance;
        }
      }

      if (logs.length > 0) {
        setLogs((prev) => [...prev.slice(-300), ...logs]);
      }

      return next;
    });
  }, [setPairStates, player, setPlayer, setLogs, addToast, setRoleLedger, setTtState, setInsuranceState]);

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
