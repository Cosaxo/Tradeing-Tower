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
  damageThread,
  growThread,
  submitRedemption as submitTtRedemption,
} from "../lib/towerTether.js";
import { detectTriggeredEvents } from "../lib/insuranceEvents.js";
import { settleMarketTick, withdrawInsurer, postInsurer } from "../lib/insuranceMarket.js";
import { settleReinsuranceTick } from "../lib/reinsurance.js";
import { appendEpochEntry } from "../lib/roleLedger.js";
import { normalizeTags, untag } from "../lib/capitalTags.js";
import { TBILL_RATE } from "../constants/system.js";
import { pushPrice } from "../state/pairState.js";
import { getEffectiveCap } from "../lib/esma.js";
import { ACTIVE_PAIRS } from "../constants/assets.js";

export function useEpochLoop({
  pairStates,       // current pairStates snapshot — used as the input to each tick
  setPairStates,    // React setter
  player,           // { id, leverage, margin, side, strategy, minYield, tip_tiers, ... }
  setPlayer,        // React setter
  openPositions = [], // current player positions — used to look up paired LAPs by id during rental settlement
  setOpenPositions, // React setter for openPositions (loop shrinks thread-linked LAPs on redemption)
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
  // Tick boundary clock for soft-close — tracks when the current
  // medium epoch began so soft-close measures against the tick window,
  // not the user's last-edit timestamp.
  const lastMediumTickRef = useRef(0);
  // Tower-Tether thread invariant: insurance and LAP must NEVER
  // calculate thread damage in the same medium tick. We split them by
  // parity — LAP fires on EVEN ticks (mediumCount % 2 === 0), insurance
  // fires on ODD ticks. When insurance has a claim that surfaces on a
  // LAP tick (i.e. an event triggered now but it isn't insurance's
  // turn), it queues here and gets applied on the next available
  // (odd) tick — the "skip to next available epoch" rule.
  const pendingInsuranceClaimsRef = useRef([]);
  // External state mirrored into refs so the tick can read the freshest
  // snapshot synchronously without React's render cycle. Crucially, the
  // tick body operates on these refs and calls setters with concrete
  // values (or pure updaters) AT THE END — never inside another
  // setState's updater. That isolates side effects from React 18
  // StrictMode's dev-mode double-invocation of state updaters.
  const pairStatesRef = useRef(pairStates);
  pairStatesRef.current = pairStates;
  const openPositionsRef = useRef(openPositions);
  openPositionsRef.current = openPositions;
  const ttStateRef = useRef(ttState);
  ttStateRef.current = ttState;
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
    // Soft-close: the last (1 − SOFT_CLOSE_PCT) of each medium epoch
    // freezes bids edited inside the freeze window. The window is
    // measured against the medium-tick boundary, NOT against the
    // user's last edit. GRACE_MS still gives a separate
    // "config-just-changed" grace period at the very end.
    const softCloseWindowMs = MEDIUM_MS * (1 - SOFT_CLOSE_PCT);
    const timeSinceLastTick = now - lastMediumTickRef.current;
    const timeIntoEpoch = lastMediumTickRef.current === 0
      ? 0
      : Math.max(0, MEDIUM_MS - (timeSinceLastTick % MEDIUM_MS));
    // We're in the soft-close window if the time remaining in this
    // epoch is less than softCloseWindowMs AND the player just edited
    // (their most recent edit landed during the freeze window).
    const editAge = now - lastPlayerEditRef.current;
    const inFreezeWindow = timeIntoEpoch < softCloseWindowMs;
    const editedInsideFreeze = editAge < softCloseWindowMs;
    const gracePeriod = editAge < GRACE_MS;
    const bidsFrozen = gracePeriod || (inFreezeWindow && editedInsideFreeze);
    lastMediumTickRef.current = now;
    mediumCountRef.current += 1;
    const doSlow = mediumCountRef.current % SLOW_EVERY === 0;

    // Side-effect collector. Replaces the old pattern of calling other
    // setters from inside the setPairStates updater (which made every
    // side effect fire twice in StrictMode dev). All accumulators are
    // drained ONCE after the pure compute phase finishes.
    const sideEffects = {
      logs: [],
      playerOverrides: null,    // absolute set from per-pair player settle
      playerMarginDelta: 0,     // accumulated cash flows added on top
      roleEntries: [],
      nextTtState: null,
      nextInsuranceState: null,
      toasts: [],
    };

    {
      const prev = pairStatesRef.current;
      const logs = sideEffects.logs;
      const next = { ...prev };

      // Working TT state for thread growth/damage. The per-pair block
      // mutates this incrementally as rental tips compound into threads;
      // the global blocks below also mutate it. We persist the final
      // version into sideEffects at the apply phase.
      let workingTtRunning = ttStateRef.current;
      // Aggregated insurer-stake adds resulting from thread growth this
      // tick. Applied to insuranceState before the global insurance
      // settlement runs so premium streams account for the new size.
      // Shape: { [eventId]: { [ownerId]: dollarAmount } }
      const insurerAddsByMarket = {};
      // LAP-margin top-ups from thread growth, accumulated for the
      // apply phase. Shape: { [lapId]: dollarAmount }
      const lapMarginAddByLapId = {};

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
        // Detect "just restocked" by id-matching against the pre-tick
        // snapshot (regimeUpdatedNpcs). Index-aligned compare would
        // silently misclassify if anything reorders the NPC array.
        const preById = new Map(regimeUpdatedNpcs.map((n) => [n.id, n]));
        const justRestocked = restockedNpcs.filter((n) => {
          const pre = preById.get(n.id);
          return (pre?.restockRemaining ?? 0) === 1 && (n.restockRemaining ?? 0) === 0;
        });
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
        const settledById = new Map(restockedNpcs.map((n) => [n.id, n]));
        const deadThisEpoch = updatedNpcs.filter((n) => {
          const pre = settledById.get(n.id);
          const preMargin = pre?.current_margin ?? pre?.base_margin ?? 0;
          return preMargin > 0 && n.current_margin === 0;
        });
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

            // Absolute reset of player state from this pair's settlement.
            // Combined with playerMarginDelta (rental tips, insurance flows,
            // redemption dollars) below at apply time.
            sideEffects.playerOverrides = {
              margin: playerSettled.margin,
              pnl: playerSettled.pnl ?? 0,
              liquidated: playerSettled.liquidated,
              normaliseTagsAt: playerSettled.margin,
            };
            if (playerSettled.liquidated) {
              sideEffects.toasts.push([`Liquidated on ${pk}!`, "error"]);
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

        // Owner-tip income. For ordinary (non-thread) paired LAPs, tips
        // flush to the player's wallet margin. For THREAD-LINKED paired
        // LAPs (the layer-3 of a TT thread), tips compound into the
        // thread instead — principal + layers 1/2/3 grow by the tip
        // amount, but ttFace stays put. That's the user's decision: no
        // auto-mint at layer 4, but auto-deploy across the other three.
        //
        // To split the thread-linked share from the wallet share, we
        // re-derive the per-LAP tip for this tick. The settleRentals
        // accrual is `tipRate × legNotional` per active rental — we
        // sum that across all rentals owned by the player, then route
        // the thread-linked portion via growThread.
        const ownerCredits = rentalSettle.ownerCredits ?? {};
        const playerTotalTip = ownerCredits[pid] ?? 0;

        // Per-LAP tip attribution (this-tick income). Pre-settlement
        // values match settleRentals' per-rental tipFee.
        const tipByLapId = {};
        for (const r of activeRentals) {
          if (!r.active) continue;
          const lap = findPairedLap(r.pairLapId);
          if (!lap || lap.ownerId !== undefined && lap.ownerId !== pid) continue;
          const legNotional = ((lap.margin ?? 0) / 2) * (lap.leverage ?? 1);
          tipByLapId[r.pairLapId] =
            (tipByLapId[r.pairLapId] ?? 0) + r.tipRate * legNotional;
        }

        let threadLinkedShare = 0;
        for (const [lapId, tip] of Object.entries(tipByLapId)) {
          if (tip <= 1e-9) continue;
          const lap = findPairedLap(lapId);
          if (!lap?.threadId || !workingTtRunning) continue;
          const thread = (workingTtRunning.threads ?? []).find(
            (t) => t.id === lap.threadId
          );
          if (!thread || thread.closed || thread.ownerId !== pid) continue;
          const grown = growThread({
            ttState: workingTtRunning,
            threadId: thread.id,
            gain: tip,
          });
          if (grown.gainApplied <= 1e-9) continue;
          workingTtRunning = grown.ttState;
          threadLinkedShare += grown.gainApplied;
          // Insurer-side stake adds — applied to markets in the
          // post-forEach reconciliation below.
          for (const [eventId, add] of Object.entries(grown.insuranceLayerAdds)) {
            if (add <= 1e-9) continue;
            insurerAddsByMarket[eventId] = insurerAddsByMarket[eventId] ?? {};
            insurerAddsByMarket[eventId][thread.ownerId] =
              (insurerAddsByMarket[eventId][thread.ownerId] ?? 0) + add;
          }
          if (grown.lapLayerAdd > 0) {
            lapMarginAddByLapId[lapId] =
              (lapMarginAddByLapId[lapId] ?? 0) + grown.lapLayerAdd;
          }
          logs.push(
            `[TT-THREAD GROW] ${thread.id} +$${grown.gainApplied.toFixed(2)} (rental tips → layers 1/2/3, ttFace fixed)`
          );
        }

        const playerOwnerCreditAfterThreads = playerTotalTip - threadLinkedShare;
        if (playerOwnerCreditAfterThreads > 0) {
          sideEffects.playerMarginDelta += playerOwnerCreditAfterThreads;
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
        if (playerRoleEntry) {
          sideEffects.roleEntries.push(playerRoleEntry);
        }
      });

      // -----------------------------------------------------------------
      // Apply thread-growth insurer-side stake adds to the insurance
      // markets before the settlement block runs. The newly-deployed
      // dollars start earning premium income from the very next
      // settle tick.
      // -----------------------------------------------------------------
      if (Object.keys(insurerAddsByMarket).length > 0 && insuranceStateRef.current) {
        let workingIns = insuranceStateRef.current;
        workingIns = {
          ...workingIns,
          markets: workingIns.markets.map((m) => {
            const adds = insurerAddsByMarket[m.eventId];
            if (!adds) return m;
            let nextMarket = m;
            for (const [uid, amount] of Object.entries(adds)) {
              if (amount <= 1e-9) continue;
              const r = postInsurer({ market: nextMarket, userId: uid, amount });
              if (r.ok) nextMarket = r.market;
            }
            return nextMarket;
          }),
        };
        insuranceStateRef.current = workingIns;
        sideEffects.nextInsuranceState = workingIns;
      }
      // Persist the running TT state from any growThread mutations
      // before the global blocks below read it.
      if (workingTtRunning !== ttStateRef.current) {
        ttStateRef.current = workingTtRunning;
        sideEffects.nextTtState = workingTtRunning;
      }

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
      if (insuranceStateRef.current) {
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
        // Thread damage from this tick's claim losses, keyed per-market
        // so we can either apply it now (insurance tick) or queue it for
        // the next odd tick when LAP is calculating now (the
        // epoch-separation invariant). Shape:
        //   [{ eventId, lossesByUser: { [uid]: $ } }]
        const tickClaimLosses = [];

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
          if (Object.keys(r.claimOut).length > 0) {
            tickClaimLosses.push({ eventId: m.eventId, lossesByUser: r.claimOut });
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

        // -----------------------------------------------------------------
        // Thread damage propagation (insurance side)
        //
        // Critical invariant: insurance and LAP must NEVER calculate
        // thread damage in the same medium tick. Insurance owns ODD
        // ticks (mediumCount % 2 === 1). On EVEN ticks, claim losses
        // queue into pendingInsuranceClaimsRef and apply on the next
        // available (odd) tick — "skip to next available epoch".
        // -----------------------------------------------------------------
        const insuranceTurn = mediumCountRef.current % 2 === 1;
        if (tickClaimLosses.length > 0 && !insuranceTurn) {
          pendingInsuranceClaimsRef.current.push(...tickClaimLosses);
          logs.push(
            `[TT-THREAD] ${tickClaimLosses.length} claim(s) deferred to next insurance tick (LAP turn)`
          );
        }
        const claimsToApply = insuranceTurn
          ? [...pendingInsuranceClaimsRef.current, ...tickClaimLosses]
          : [];
        if (insuranceTurn) pendingInsuranceClaimsRef.current = [];

        let workingTtForDamage = ttStateRef.current;
        let totalLapDamageDelta = 0;
        const playerThreadStakeRelease = { delta: 0 };
        if (claimsToApply.length > 0 && workingTtForDamage) {
          for (const { eventId, lossesByUser } of claimsToApply) {
            for (const [uid, lossAmt] of Object.entries(lossesByUser)) {
              if (lossAmt <= 0) continue;
              const userThreads = (workingTtForDamage.threads ?? []).filter(
                (t) =>
                  !t.closed &&
                  t.ownerId === uid &&
                  (t.insuranceWeights?.[eventId] ?? 0) > 0 &&
                  t.principal > 1e-9
              );
              if (userThreads.length === 0) continue;
              // Pro-rata across this user's threads, weighted by each
              // thread's exposure to the triggering market.
              const exposure = userThreads.map(
                (t) => t.principal * (t.insuranceWeights[eventId] ?? 0)
              );
              const totalExposure = exposure.reduce((s, v) => s + v, 0);
              if (totalExposure <= 0) continue;
              const damageBudget = Math.min(lossAmt, totalExposure);
              for (let i = 0; i < userThreads.length; i++) {
                const t = userThreads[i];
                const share = exposure[i] / totalExposure;
                const dmgAmount = damageBudget * share;
                if (dmgAmount <= 1e-9) continue;
                const dmg = damageThread({
                  ttState: workingTtForDamage,
                  threadId: t.id,
                  delta: dmgAmount,
                });
                if (dmg.deltaApplied <= 1e-9) continue;
                workingTtForDamage = dmg.ttState;
                totalLapDamageDelta += dmg.lapLayerDelta;
                if (uid === pid) {
                  playerThreadStakeRelease.delta += dmg.deltaApplied;
                }
                // Withdraw the per-market layer deltas from the
                // insurance markets (the insurance loss already
                // happened in settleMarketTick — but for OTHER markets
                // covered by this same thread, the principal write-down
                // needs to shrink those stakes too so the thread layers
                // stay in sync).
                nextInsurance.markets = nextInsurance.markets.map((m) => {
                  const cut = dmg.insuranceLayerDeltas[m.eventId] ?? 0;
                  if (cut <= 1e-9) return m;
                  // The triggering market already wrote down via
                  // settleMarketTick (claimOut); skip to avoid double-debit.
                  if (m.eventId === eventId) return m;
                  const r = withdrawInsurer({
                    market: m,
                    userId: uid,
                    amount: cut,
                  });
                  return r.ok ? r.market : m;
                });
                logs.push(
                  `[TT-THREAD ${t.id}] insurance damage $${dmg.deltaApplied.toFixed(2)} (event ${eventId}) — all 4 layers shrunk`
                );
              }
            }
          }
        }

        if (workingTtForDamage !== ttStateRef.current) {
          ttStateRef.current = workingTtForDamage;
          sideEffects.nextTtState = workingTtForDamage;
        }

        // Shrink the player's thread-linked paired LAPs by the
        // accumulated lapLayerDelta. We hit each thread's LAP
        // proportionally to the damage it took.
        if (totalLapDamageDelta > 0) {
          // The actual mutation is left to the position list update
          // below — we collect intent here.
          sideEffects.lapShrinkIntents = sideEffects.lapShrinkIntents ?? [];
          // Using the per-thread deltas captured during damage; the
          // openPositions reducer below reads from threads after damage.
        }
        if (playerThreadStakeRelease.delta > 0) {
          sideEffects.threadStakeRelease =
            (sideEffects.threadStakeRelease ?? 0) + playerThreadStakeRelease.delta;
        }

        sideEffects.nextInsuranceState = nextInsurance;
        // Persist the working copy for downstream blocks (redemption
        // haircut application reads it via the ref).
        insuranceStateRef.current = nextInsurance;

        const playerNet = playerCashChanges[pid] ?? 0;
        if (playerNet !== 0) {
          sideEffects.playerMarginDelta += playerNet;
        }
      }

      // -----------------------------------------------------------------
      // Tower Tether redemption cycle (thread-based)
      //
      // Runs on its own prime stride (REDEMPTION_EVERY) coprime with
      // analytics + insurance/LAP, ~monthly in sim-days. On each cycle:
      //   1. Merchant simulator queues 50% of its TT balance for
      //      standard redemption — creates organic queue pressure.
      //   2. runRedemptionCycle drains express + standard requests up
      //      to the 10% cap and returns thread-level unwinds.
      //   3. Apply each unwind: T-bills already paid out as $ to the
      //      redeemer; per-thread, withdraw the insurance fill from
      //      every covered market AND shrink the paired LAP by the
      //      same amount. Releases threadStake tag from the minter.
      //   4. Route express penalty to reinsurance sellers.
      //   5. Pay redemption dollars to each holder's margin.
      //   6. Solvency recheck per affected minter.
      // -----------------------------------------------------------------
      if (mediumCountRef.current % REDEMPTION_EVERY === 0 && ttStateRef.current) {
        const tickEpoch = epochOfFirstPair(next);
        let workingTt = ttStateRef.current;
        let workingInsurance = insuranceStateRef.current;

        // Step 1: merchant auto-redemption.
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

        // Step 3: apply per-thread unwinds. For each unwind:
        //   - withdraw the per-market insurance stakes (split by the
        //     thread's insuranceWeights — already computed inside
        //     damageThread and returned in insuranceLayerDeltas)
        //   - shrink the paired LAP's margin (or close it if the
        //     remaining margin would fall below dust threshold)
        //   - release the minter's threadStake tag (local player only)
        const lapShrinkByLapId = {}; // { [lapId]: dollarAmountToShrink }
        const threadStakeReleaseByOwner = {};
        for (const u of cycle.threadUnwinds) {
          if (workingInsurance && u.insuranceLayerDeltas) {
            workingInsurance = {
              ...workingInsurance,
              markets: workingInsurance.markets.map((m) => {
                const cut = u.insuranceLayerDeltas[m.eventId] ?? 0;
                if (cut <= 1e-9) return m;
                const r = withdrawInsurer({
                  market: m,
                  userId: u.ownerId,
                  amount: cut,
                });
                return r.ok ? r.market : m;
              }),
            };
          }
          if (u.lapId && u.lapLayerDelta > 0) {
            lapShrinkByLapId[u.lapId] =
              (lapShrinkByLapId[u.lapId] ?? 0) + u.lapLayerDelta;
          }
          threadStakeReleaseByOwner[u.ownerId] =
            (threadStakeReleaseByOwner[u.ownerId] ?? 0) + u.delta;
        }
        if (cycle.threadUnwinds.length > 0) {
          logs.push(
            `[TT-UNWIND] ${cycle.threadUnwinds.length} thread(s) shrunk · total $${cycle.threadUnwinds
              .reduce((s, u) => s + u.delta, 0)
              .toFixed(2)}`
          );
        }

        // Step 4: express-penalty → reinsurance sellers.
        if (cycle.penaltyToPool > 0 && workingInsurance?.reinsurance?.length) {
          const totalCov = workingInsurance.reinsurance.reduce(
            (s, p) => s + (p.coverageFraction ?? 0),
            0
          ) || 1;
          const splitProducts = workingInsurance.reinsurance.map((p) => {
            const share = (p.coverageFraction ?? 0) / totalCov;
            const credit = cycle.penaltyToPool * share;
            if (credit <= 0 || (p.sellerCapital ?? 0) <= 0) return p;
            const newPositions = { ...p.sellerPositions };
            for (const [uid, stake] of Object.entries(p.sellerPositions ?? {})) {
              const fraction = stake / p.sellerCapital;
              newPositions[uid] = stake + credit * fraction;
            }
            return {
              ...p,
              sellerPositions: newPositions,
              sellerCapital: (p.sellerCapital ?? 0) + credit,
            };
          });
          workingInsurance = { ...workingInsurance, reinsurance: splitProducts };
          logs.push(
            `[TT-PENALTY] $${cycle.penaltyToPool.toFixed(2)} routed to reinsurance sellers (split by coverageFraction)`
          );
        }

        // Step 5: pay redemption dollars out to the holder's margin.
        const playerDollars = cycle.dollarsOut[player?.id] ?? 0;
        if (playerDollars > 0) {
          sideEffects.playerMarginDelta += playerDollars;
        }

        // Step 6: solvency recheck per affected minter.
        const affectedMinters = new Set(cycle.threadUnwinds.map((u) => u.ownerId));
        for (const minterId of affectedMinters) {
          const solvency = applySolvencyCheck({
            ttState: workingTt,
            userId: minterId,
          });
          workingTt = solvency.ttState;
          if (solvency.clawback > 0 || solvency.newDebt > 0) {
            logs.push(
              `[TT-SOLVENCY] ${minterId} clawback ${solvency.clawback.toFixed(2)} TT, debt +${solvency.newDebt.toFixed(2)}`
            );
          }
        }

        // Stash LAP-shrink intents for the position update below to
        // consume.
        sideEffects.lapShrinkByLapId = lapShrinkByLapId;
        sideEffects.threadStakeReleaseByOwner = threadStakeReleaseByOwner;

        sideEffects.nextTtState = workingTt;
        if (workingInsurance && workingInsurance !== insuranceStateRef.current) {
          sideEffects.nextInsuranceState = workingInsurance;
          insuranceStateRef.current = workingInsurance;
        }
      }

      // ---- Apply phase ----------------------------------------------------
      // All setters run exactly once here, AFTER the pure compute above.
      // No setter ever runs from inside another setter's updater, so React
      // 18 StrictMode dev-mode double-invocation can't double our side
      // effects. Updaters that remain in function form below are pure
      // (depend only on their `prev` argument) so doubling is harmless.
      setPairStates(next);
      pairStatesRef.current = next;

      if (sideEffects.nextTtState) {
        setTtState(sideEffects.nextTtState);
        ttStateRef.current = sideEffects.nextTtState;
      }
      if (sideEffects.nextInsuranceState) {
        setInsuranceState(sideEffects.nextInsuranceState);
        insuranceStateRef.current = sideEffects.nextInsuranceState;
      }

      const overrides = sideEffects.playerOverrides;
      const delta = sideEffects.playerMarginDelta;
      // Thread-stake tag release: when redemption unwinds shrink the
      // player's threads, the same dollar amount comes off the
      // threadStake tag. Damage propagation (insurance side) does the
      // same.
      const pid = player?.id ?? "You";
      const threadStakeRelease =
        (sideEffects.threadStakeReleaseByOwner?.[pid] ?? 0) +
        (sideEffects.threadStakeRelease ?? 0);
      if (overrides || delta !== 0 || threadStakeRelease > 0) {
        setPlayer((prev) => {
          const baseMargin = overrides ? overrides.margin : (prev.margin ?? 0);
          let baseTags = overrides
            ? normalizeTags(overrides.normaliseTagsAt, prev.tags ?? {})
            : prev.tags;
          if (threadStakeRelease > 0) {
            baseTags = untag(baseTags ?? {}, "threadStake", threadStakeRelease);
          }
          const next = { ...prev };
          if (overrides) {
            next.pnl = overrides.pnl;
            next.liquidated = overrides.liquidated;
          }
          if (overrides || threadStakeRelease > 0) {
            next.tags = baseTags;
          }
          next.margin = baseMargin + delta;
          return next;
        });
      }

      // Apply paired-LAP shrinks from redemption thread-unwinds AND
      // paired-LAP grows from thread tip compounding. Net the two
      // first so a LAP that both shrank and grew this tick gets a
      // single margin update.
      const shrinks = sideEffects.lapShrinkByLapId ?? {};
      const grows = lapMarginAddByLapId;
      const lapDeltas = {};
      for (const [lapId, cut] of Object.entries(shrinks)) {
        lapDeltas[lapId] = (lapDeltas[lapId] ?? 0) - cut;
      }
      for (const [lapId, add] of Object.entries(grows)) {
        lapDeltas[lapId] = (lapDeltas[lapId] ?? 0) + add;
      }
      const lapDeltaIds = Object.keys(lapDeltas);
      if (lapDeltaIds.length > 0 && setOpenPositions) {
        setOpenPositions((prev) => {
          let changed = false;
          const out = [];
          for (const pos of prev) {
            const d = lapDeltas[pos?.id] ?? 0;
            if (Math.abs(d) <= 1e-9) {
              out.push(pos);
              continue;
            }
            const newMargin = (pos.margin ?? 0) + d;
            changed = true;
            if (newMargin <= 1) continue; // drop dust on full unwind
            out.push({ ...pos, margin: newMargin });
          }
          return changed ? out : prev;
        });
      }

      for (const entry of sideEffects.roleEntries) {
        setRoleLedger((prev) => appendEpochEntry(prev, entry));
      }

      for (const [msg, kind] of sideEffects.toasts) addToast(msg, kind);

      if (sideEffects.logs.length > 0) {
        setLogs((prev) => [...prev.slice(-300), ...sideEffects.logs]);
      }
    }
  }, [setPairStates, player, setPlayer, setLogs, addToast, setRoleLedger, setTtState, setInsuranceState, setOpenPositions]);

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
