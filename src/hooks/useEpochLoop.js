// Three-tier epoch loop.
//
//  Fast   (FAST_MS  ≈ 1 s): advance prices, safety barrier check per pair
//  Medium (MEDIUM_MS ≈ 6 s): run auctions, settle pools, update NPCs, contracts
//  Slow   (every SLOW_EVERY medium ticks): analytics, insurance pool, regime, correlation

import { useEffect, useRef, useCallback } from "react";
import { FAST_MS, MEDIUM_MS, SLOW_EVERY, GRACE_MS } from "../constants/system.js";
import { priceStep } from "../lib/priceModels.js";
import { calcRealizedSigma } from "../lib/math.js";
import { detectRegime } from "../lib/regime.js";
import { updateNpcRegime, applyNpcSettlement, tickNpcRestock, isNpcActive } from "../lib/npcs.js";
import { runAuction } from "../lib/auction.js";
import { settleDominantPool, calcRatioBeta } from "../lib/pool.js";
import { settleImbalanceContracts, settleEntropyContracts } from "../lib/contracts.js";
import { settleStrips } from "../lib/strips.js";
import { settleInsurancePool } from "../lib/insurance.js";
import { updateYieldModel, calcYieldBufferContribution } from "../lib/yieldModel.js";
import { calcCrossMarketCorrelations } from "../lib/correlation.js";
import { settleLending } from "../lib/lending.js";
import { generateNpcOrders } from "../lib/npcMarkets.js";
import { pushPrice } from "../state/pairState.js";
import { getEffectiveCap } from "../lib/esma.js";
import { ACTIVE_PAIRS } from "../constants/assets.js";

export function useEpochLoop({
  pairStates: _pairStates, // reserved for future read-only access
  setPairStates,    // React setter
  player,           // { id, leverage, margin, side, strategy, minYield, tip_tiers, ... }
  setPlayer,        // React setter
  setLogs,          // (fn) => void
  addToast,         // (msg, type) => void
  running,          // boolean
  speed = 1,        // multiplier: 0.5x, 1x, 2x, 5x
}) {
  const mediumCountRef = useRef(0);
  const lastPlayerEditRef = useRef(0);

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
    const gracePeriod = now - lastPlayerEditRef.current < GRACE_MS;
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

      // --- Collect all auction results for insurance pool (slow only) ---
      const allPairAuctions = {};

      ACTIVE_PAIRS.forEach((pk) => {
        const ps = prev[pk];
        if (!ps) return;

        const { prices, realizedSigma, npcs, regime, yieldModel,
                smileParams, metaParams, prevSmoothFills, alpha,
                imbalanceContracts, entropyContracts, strips,
                insurancePool, epochIndex, yieldBuffer = 0,
                yieldBufferEpochs = 0, regimeHistory = [],
                lendingOffers = [], lendingBorrows = [] } = ps;

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
        if (!gracePeriod && player && player.activePair === pk) {
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

        // Build user list for pool settlement (active NPC + player positions).
        const poolUsers = activeNpcs.map((npc) => ({
          id: npc.id,
          margin: npc.current_margin ?? npc.base_margin,
          leverage: Math.min(npc.max_lev, cap),
          side: npc.strategy?.includes("SHORT") ? "SHORT" : "LONG",
          active: true,
        }));
        if (!gracePeriod && player?.activePair === pk) {
          poolUsers.push({
            id: player.id ?? "You",
            margin: player.margin ?? 5000,
            leverage: Math.min(player.leverage ?? 1, cap),
            side: player.side ?? "LONG",
            active: true,
          });
        }

        const { users: settledUsers, stabilityFeeCollected, logs: poolLogs } =
          settleDominantPool(poolUsers, priceOld, priceNew, realizedSigma, corrMap);
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
        if (!gracePeriod && player?.activePair === pk) {
          const playerSettled = settledUsers.find((u) => u.id === (player.id ?? "You"));
          if (playerSettled) {
            setPlayer((prev) => ({
              ...prev,
              margin: playerSettled.margin,
              pnl: playerSettled.pnl ?? 0,
              liquidated: playerSettled.liquidated,
            }));
            if (playerSettled.liquidated) {
              addToast(`Liquidated on ${pk}!`, "error");
            }
          }
        }

        // NPC market participation: produce offers + contract purchases + strip buys.
        const avgEntMultPre =
          auctionResult.normWeights?.reduce((s, w) => s + w, 0) /
          Math.max(1, auctionResult.normWeights?.length ?? 1);
        const npcOrders = generateNpcOrders({
          npcs: updatedNpcs.filter(isNpcActive),
          existingOffers: lendingOffers,
          longMargin,
          shortMargin,
          regime: updatedRegime,
          normWeights: auctionResult.normWeights ?? [],
          avgEntropyMult: avgEntMultPre ?? 1,
          realizedSigma,
          returnHistory: ps.returnHistory,
          epochIndex,
        });

        // Settle contracts (including the fresh NPC buys).
        const imbalanceContractsWithNpcs = [
          ...imbalanceContracts,
          ...npcOrders.imbalanceBuys,
        ];
        const entropyContractsWithNpcs = [
          ...entropyContracts,
          ...npcOrders.entropyBuys,
        ];
        const { settled: imbalSettled, logs: imbalLogs } =
          settleImbalanceContracts(imbalanceContractsWithNpcs, longMargin, shortMargin);
        imbalLogs.forEach((l) => logs.push(l));
        if (npcOrders.imbalanceBuys.length > 0) {
          logs.push(`[NPC-IMB] ${npcOrders.imbalanceBuys.length} new buyers`);
        }

        const { settled: entSettled, logs: entLogs } =
          settleEntropyContracts(entropyContractsWithNpcs, auctionResult.normWeights, avgEntMultPre ?? 1);
        entLogs.forEach((l) => logs.push(l));
        if (npcOrders.entropyBuys.length > 0) {
          logs.push(`[NPC-ENT] ${npcOrders.entropyBuys.length} new buyers`);
        }

        // Settle strips (including fresh NPC strip buys).
        const currentYield = auctionResult.matched.length > 0
          ? auctionResult.matched.reduce((s, m) => s + m.longTip, 0) / auctionResult.matched.length
          : 0;
        const playerMarginForStrips = player?.activePair === pk ? (player.margin ?? 5000) : 0;
        const stripsWithNpcs = [...strips, ...npcOrders.stripBuys];
        const { settled: stripsSettled, totalPremiumCollected, logs: stripsLogs } =
          settleStrips(stripsWithNpcs, currentYield, realizedSigma, ps.returnHistory, playerMarginForStrips);
        stripsLogs.forEach((l) => logs.push(l));
        if (npcOrders.stripBuys.length > 0) {
          logs.push(`[NPC-STRIP] ${npcOrders.stripBuys.length} new strips`);
        }

        // Update insurance pool pending premiums.
        let nextPool = {
          ...insurancePool,
          pendingPremiums: insurancePool.pendingPremiums + totalPremiumCollected + stabilityFeeCollected,
          pendingStabilityFee: 0,
        };

        // Slow: settle insurance pool + yield model + correlations.
        let slowLogs = [];
        if (doSlow) {
          const { pool: settledPool, log } = settleInsurancePool(nextPool, allPairAuctions, epochIndex);
          nextPool = settledPool;
          slowLogs = log;
        }

        const updatedYieldModel = updateYieldModel(yieldModel, currentYield);

        // Yield buffer: skim excess into reserve, draw from reserve on pool shortfall.
        const bufferContrib = calcYieldBufferContribution(currentYield, yieldBufferEpochs, yieldBuffer);
        let newYieldBuffer = yieldBuffer + bufferContrib;

        // If pool had unmet claims this epoch, draw from buffer to subsidise.
        const unmet = nextPool.pendingClaims ?? 0;
        if (unmet > 0 && newYieldBuffer > 0) {
          const draw = Math.min(unmet, newYieldBuffer);
          newYieldBuffer -= draw;
          nextPool = {
            ...nextPool,
            pendingClaims: Math.max(0, unmet - draw),
          };
          logs.push(
            `[BUFFER DRAW] ${pk}: drew $${draw.toFixed(2)} to cover pool shortfall (${unmet.toFixed(2)} unmet)`
          );
        }

        // Settle lending market (NPC offers added before settlement).
        const offersWithNpcs = [...lendingOffers, ...npcOrders.offers];
        const { borrows: settledBorrows, offers: settledOffers, totalRent, logs: lendLogs } =
          settleLending(lendingBorrows, offersWithNpcs);
        lendLogs.forEach((l) => logs.push(l));
        void totalRent;
        if (npcOrders.offers.length > 0) {
          logs.push(`[NPC-LEND] ${npcOrders.offers.length} new lending offers`);
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
          imbalanceContracts: imbalSettled.filter((c) => !c.expired),
          entropyContracts: entSettled.filter((c) => !c.expired),
          strips: stripsSettled,
          insurancePool: nextPool,
          yieldModel: updatedYieldModel,
          yieldBuffer: newYieldBuffer,
          yieldBufferEpochs: yieldBufferEpochs + 1,
          lendingBorrows: settledBorrows,
          lendingOffers: settledOffers,
          epochIndex: epochIndex + 1,
          correlationMap: doSlow ? corrMap : ps.correlationMap,
          currentYield,
        };

        if (slowLogs.length > 0) slowLogs.forEach((l) => logs.push(l));
      });

      if (logs.length > 0) {
        setLogs((prev) => [...prev.slice(-300), ...logs]);
      }

      return next;
    });
  }, [setPairStates, player, setPlayer, setLogs, addToast]);

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
