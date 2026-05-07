// Three-tier epoch loop.
//
//  Fast   (FAST_MS  ≈ 1 s): advance prices, safety barrier check per pair
//  Medium (MEDIUM_MS ≈ 6 s): run auctions, settle pools, update NPCs, contracts
//  Slow   (every SLOW_EVERY medium ticks): analytics, insurance pool, regime, correlation

import { useEffect, useRef, useCallback } from "react";
import { FAST_MS, MEDIUM_MS, SLOW_EVERY, REDEMPTION_EVERY, INSURANCE_STRIDE, GRACE_MS, SOFT_CLOSE_PCT } from "../constants/system.js";
import { priceStep } from "../lib/priceModels.js";
import { calcRealizedSigma, calcRatioBeta as calcRatioBetaStat, ratioEffectiveSigma } from "../lib/math.js";
import { detectRegime } from "../lib/regime.js";
import { runAuction } from "../lib/auction.js";
import { settleDominantPool, calcRatioBeta, escrowTips } from "../lib/pool.js";
import { updateYieldModel } from "../lib/yieldModel.js";
import { calcCrossMarketCorrelations } from "../lib/correlation.js";
import { matchRentalAuction, settleRentals } from "../lib/rentalMarket.js";
import { filterValid, isValidAuctionBid, isValidPoolUser, isValidRentalBid } from "../lib/orderFlow.js";
import { isPairedLap } from "../lib/pairedLap.js";
import {
  runRedemptionCycle,
  applySolvencyCheck,
  damageThread,
  submitRedemption as submitFloatsRedemption,
} from "../lib/floats.js";
import { adjustThreadDerived } from "../lib/bBookPool.js";
import { absorbImbalance, distributeRebate } from "../lib/lapPool.js";
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
  setOpenPositions, // React setter for openPositions
  floatsState = null,   // Float global state (threads, balances, queue, etc.)
  setFloatsState,       // React setter for FLOAT state
  insuranceState = null, // global insurance markets + reinsurance + allocations
  setInsuranceState,     // React setter for insuranceState
  bBookState = null, // global B-book pool state (Tier-3b — opt-in bookie)
  setBBookState,    // React setter for bBookState
  lapPoolState = null, // global LAP pool state (Tier-3a default — passive LP)
  setLapPoolState,  // React setter for lapPoolState
  setLogs,          // (fn) => void
  addToast,         // (msg, type) => void
  running,          // boolean
  speed = 1,        // multiplier: 0.5x, 1x, 2x, 5x
  setRoleLedger,    // setter for per-role attribution ledger
  flowAdapter,      // OrderFlowAdapter — pluggable source of market flow
                    //   (DefaultBotAdapter, ReplayAdapter, BrokerAdapter, ...)
                    //   Falls back to no-flow if undefined.
}) {
  const mediumCountRef = useRef(0);
  const lastPlayerEditRef = useRef(0);
  // Tick boundary clock for soft-close — tracks when the current
  // medium epoch began so soft-close measures against the tick window,
  // not the user's last-edit timestamp.
  const lastMediumTickRef = useRef(0);
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
  const floatsStateRef = useRef(floatsState);
  floatsStateRef.current = floatsState;
  const insuranceStateRef = useRef(insuranceState);
  insuranceStateRef.current = insuranceState;
  const bBookStateRef = useRef(bBookState);
  bBookStateRef.current = bBookState;
  const lapPoolStateRef = useRef(lapPoolState);
  lapPoolStateRef.current = lapPoolState;

  // Helper: pick a representative epoch from the pair-states object.
  // Used by the FLOAT redemption cycle which is global, not per-pair.
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

      // Working FLOAT state for thread growth/damage. The per-pair block
      // mutates this incrementally as rental tips compound into threads;
      // the global blocks below also mutate it. We persist the final
      // version into sideEffects at the apply phase.
      let workingTtRunning = floatsStateRef.current;
      // Working LAP pool state — accumulates absorbed contracts + rebate
      // income across all pairs in this tick. The pool absorbs each
      // pair's auction imbalance after runAuction; rebate flows to LPs
      // pro-rata; absorbed positions are mark-to-market closed in the
      // next tick (or held until manually closed). Persisted at the
      // apply phase.
      let workingLapPool = lapPoolStateRef.current;
      // Aggregate rebate-share to player's voluntary stake — flushed to
      // wallet margin at apply phase so users see the income immediately.
      let lapRebateToPlayerWallet = 0;
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

        const { prices, realizedSigma, regime, yieldModel,
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

        // Pull market flow from the adapter. The loop is agnostic to
        // the source — DefaultBotAdapter wraps the legacy NPCs;
        // ReplayAdapter reads a recorded tape; BrokerAdapter would
        // pull from a live feed. Schema guards strip malformed entries
        // at the boundary so a bad upstream record can't poison the
        // auction's internal math.
        const { effectiveCap: cap } = getEffectiveCap(pk, realizedSigma);
        const flow = flowAdapter
          ? flowAdapter.run({
              pairKey: pk,
              epoch: epochIndex,
              pairState: ps,
              regime: updatedRegime,
              yieldModel,
              cap,
            })
          : { participants: [], poolUsers: [], rentalBids: [], snapshot: [] };
        const { valid: validParticipants, dropped: droppedBids } = filterValid(
          flow.participants ?? [],
          isValidAuctionBid
        );
        const { valid: validPoolUsers } = filterValid(flow.poolUsers ?? [], isValidPoolUser);
        const { valid: adapterRentalBids } = filterValid(flow.rentalBids ?? [], isValidRentalBid);
        if (droppedBids.length > 0) {
          logs.push(`[FLOW] dropped ${droppedBids.length} malformed bid(s) at adapter boundary`);
        }
        // Adapter "just restocked" detection — replaces the inline scan.
        if (flowAdapter?.markRestockedFromSnapshot) {
          const restockedIds = flowAdapter.markRestockedFromSnapshot({ pairKey: pk });
          for (const id of restockedIds) {
            const bot = (flow.snapshot ?? []).find((n) => n.id === id);
            if (bot) logs.push(`[BOT] ${id} restocked to $${bot.base_margin}`);
          }
        }

        // Build participants: adapter flow + player bid (if not frozen).
        const participants = [...validParticipants];
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

        // LAP pool absorbs the auction's imbalance (Path A — the
        // default Tier-3 economic role). Absorbed flow earns the
        // entropy-rebate tip; the rebate is distributed pro-rata to
        // LP stakes immediately. Directional positions accumulate as
        // active contracts on the pool; they're mark-to-market and
        // closed elsewhere (or remain open across ticks).
        if (workingLapPool && (workingLapPool.totalStake ?? 0) > 0) {
          const priceNew = prices[prices.length - 1];
          const absorb = absorbImbalance({
            state: workingLapPool,
            unmatchedLongs: auctionResult.unmatchedLongs,
            unmatchedShorts: auctionResult.unmatchedShorts,
            normWeights: auctionResult.normWeights,
            bucketLevs: auctionResult.bucketLevs,
            openPrice: priceNew,
            currentEpoch: epochIndex,
          });
          workingLapPool = absorb.state;
          if (absorb.totalRebate > 0) {
            const dist = distributeRebate({
              state: workingLapPool,
              totalRebate: absorb.totalRebate,
            });
            workingLapPool = dist.state;
            // Voluntary share for the local player flushes to wallet
            // margin (visible income); thread-derived share already
            // compounded into the user's threadDerivedStake by the
            // distributeRebate stake-mutation logic.
            const playerShare = dist.lpShares?.[player?.id];
            if (playerShare?.voluntary > 0) {
              lapRebateToPlayerWallet += playerShare.voluntary;
            }
          }
          if (absorb.absorbedContracts.length > 0) {
            logs.push(
              `[LAP-POOL] absorbed ${absorb.absorbedContracts.length} unmatched bid(s) on ${pk} · rebate $${absorb.totalRebate.toFixed(2)}`
            );
          }
        }

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

        // Pool settlement uses the adapter-provided poolUsers list.
        // NPCs ONLY — the player isn't included in continuous-ambient
        // settlement (explicit-only model fixed the double-exposure
        // bug; player exposure flows through positions, not bids).
        const preSettlementSnapshot = flow.snapshot ?? [];
        const { users: settledUsers, stabilityFeeCollected, logs: poolLogs } =
          settleDominantPool(validPoolUsers, priceOld, priceNew, effectiveSigma, corrMap);
        poolLogs.forEach((l) => logs.push(l));

        // Hand settlement results back to the adapter (NPCs update
        // their margin / restock state). For replay/broker adapters
        // this is typically a no-op.
        if (flowAdapter?.applySettlement) {
          flowAdapter.applySettlement({ pairKey: pk, settledUsers });
        }
        // Liquidation detection — adapter-provided id-comparison so
        // we don't have to maintain pre/post lookup tables here.
        if (flowAdapter?.detectLiquidationsFromSnapshot) {
          const dead = flowAdapter.detectLiquidationsFromSnapshot({
            pairKey: pk,
            preSettlementSnapshot,
          });
          for (const d of dead) {
            logs.push(`[BOT] ${d.id} liquidated — restock in ${d.restockRemaining} epochs`);
          }
        }

        // Apply T-bill yield + auction tips to player margin. These are
        // the only "ambient" flows now — directional P&L is exclusively
        // through explicit positions.
        let playerRoleEntry = null;
        if (!bidsFrozen && player?.activePair === pk) {
          const preMargin = player.margin ?? 0;
          // Per-tick T-bill yield matches the magnitude that
          // settleDominantPool used to apply on the player's margin.
          const r = TBILL_RATE / 365;
          const tbill = preMargin * r;

          // Tips from auction matches — player earns them when their
          // bid pairs with an NPC counterparty.
          const pid = player.id ?? "You";
          const { tipEscrow } = escrowTips(auctionResult.matched);
          const tipEntry = tipEscrow[pid] ?? { paid: 0, received: 0 };
          const tips = tipEntry.received - tipEntry.paid;

          // Both flows accrue to playerMarginDelta — explicit, no
          // phantom P&L.
          sideEffects.playerMarginDelta += tbill + tips;

          playerRoleEntry = {
            epoch: epochIndex,
            tbill,
            auctionPnl: 0, // No phantom P&L on continuous bid.
            tips,
            poolYield: 0,
            stripPnl: 0,
            creditChange: 0,
          };
        }
        const pid = player?.id ?? "You";

        // Adapter-supplied rental bids: DefaultBotAdapter generates
        // them via npcMarkets; ReplayAdapter pulls from tape.
        // longMargin/shortMargin already computed above for ratio.
        const adapterBids = adapterRentalBids;

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

        // Owner-tip income flushes to the player's wallet margin. With
        // threads no longer holding paired LAPs as layer 3 (the layer-3
        // role moved to the B-book pool), there's no thread compounding
        // path here — rental tips are just user income on whatever
        // paired LAPs the user opened directly.
        const ownerCredits = rentalSettle.ownerCredits ?? {};
        const playerOwnerCredit = ownerCredits[pid] ?? 0;
        if (playerOwnerCredit > 0) {
          sideEffects.playerMarginDelta += playerOwnerCredit;
        }

        // Rental defaults shrink the underlying LAP's margin (real
        // loss the renter couldn't pay). Threads no longer hold LAPs,
        // so this no longer propagates into thread layers.
        const lapDeficits = rentalSettle.lapDeficitsByLapId ?? {};
        for (const [lapId, deficit] of Object.entries(lapDeficits)) {
          if (deficit <= 1e-9) continue;
          lapMarginAddByLapId[lapId] =
            (lapMarginAddByLapId[lapId] ?? 0) - deficit;
        }

        // Match the orderbook against newly-arrived adapter bids.
        const offersBeforeMatch = rentalOffers;
        const bidsBeforeMatch = [...rentalBids, ...adapterBids];
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
          // npcs is a write-through MIRROR of the adapter snapshot
          // (kept on pairState for UI compat — NpcPanel reads from
          // here). The adapter is authoritative; this is just the
          // latest cached view.
          npcs: flow.snapshot ?? [],
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
      // Apply thread-side insurer stake adjustments to the insurance
      // markets before the settlement block runs.
      //
      // Positive amounts (rental-tip growth): postInsurer — newly
      //   deployed dollars start earning premium income from the very
      //   next settle tick.
      // Negative amounts (rental-default damage): withdrawInsurer —
      //   the thread layer-2 fill shrinks pro-rata to the LAP loss
      //   that just propagated through damageThread.
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
              if (Math.abs(amount) <= 1e-9) continue;
              if (amount > 0) {
                const r = postInsurer({ market: nextMarket, userId: uid, amount });
                if (r.ok) nextMarket = r.market;
              } else {
                // Thread-driven adjust — bypass lockup (governed by
                // redemption mechanics, not the per-stake lockup).
                const r = withdrawInsurer({
                  market: nextMarket,
                  userId: uid,
                  amount: -amount,
                  bypassLockup: true,
                });
                if (r.ok) nextMarket = r.market;
              }
            }
            return nextMarket;
          }),
        };
        insuranceStateRef.current = workingIns;
        sideEffects.nextInsuranceState = workingIns;
      }
      // Persist the running FLOAT state from any growThread mutations
      // before the global blocks below read it.
      if (workingTtRunning !== floatsStateRef.current) {
        floatsStateRef.current = workingTtRunning;
        sideEffects.nextTtState = workingTtRunning;
      }
      // Persist the working LAP pool state and flush the player's
      // voluntary-share rebate to wallet margin.
      if (workingLapPool !== lapPoolStateRef.current) {
        lapPoolStateRef.current = workingLapPool;
        sideEffects.nextLapPoolState = workingLapPool;
      }
      if (lapRebateToPlayerWallet > 0) {
        sideEffects.playerMarginDelta += lapRebateToPlayerWallet;
      }

      // -----------------------------------------------------------------
      // Global insurance + reinsurance settlement (Phase 5)
      //
      // Insurance markets settle every medium tick (no rare-stride
      // delay; payouts and premium streams are tied to per-tick event
      // detection). For each market: detect whether its event triggered
      // given the freshly-updated per-pair state, then settle via
      // settleMarketTick. Aggregate buyer-side claim outflows into the
      // reinsurance settlement so a FLOAT-minter who got hit on insurance
      // recovers the corresponding fraction from reinsurance buyers.
      //
      // All cash flows (premium in/out, claim in/out, reinsurance
      // payouts/seller losses) are aggregated on a per-user basis and
      // applied to the local player's margin at the end.
      //
      // EPOCH-SEPARATION INVARIANT (Tier 1.0): the entire insurance
      // path — market settlement, reinsurance settlement, and
      // insurance-driven thread damage — runs only every
      // INSURANCE_STRIDE medium ticks. LAP / B-book damage paths,
      // when wired in Tier 1.1, run on the OFF-stride. The two
      // damage sources can never coincide on the same thread
      // principal in the same tick.
      // -----------------------------------------------------------------
      const isInsuranceTick =
        mediumCountRef.current % INSURANCE_STRIDE === 0;
      if (insuranceStateRef.current && isInsuranceTick) {
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
            // claimOut is paid out of thread-backed insurer stake.
            // The cash flow is captured by damageThread shrinking the
            // thread principal (and the per-market layer-2 stake that
            // funded the claim was the principal in the first place).
            // Debiting playerCashChanges here as well would
            // double-count the loss against the user's wallet.
            //
            // (If a future build adds non-thread-backed insurer
            // stakes — direct wallet collateral — those WILL need a
            // wallet debit here, gated on whether the user has any
            // active thread covering this event.)
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
        // When a market triggers and a thread participates as insurer,
        // the thread takes a loss equal to its share of the payout.
        // By the 4-layer invariant, all four layers shrink by that
        // amount: T-bill (principal), other insurance fills covered
        // by this thread, B-book pool stake (threadDerivedStake), and
        // floatFace.
        // -----------------------------------------------------------------
        let workingTtForDamage = floatsStateRef.current;
        let workingBBookForDamage = bBookStateRef.current;
        const playerThreadStakeRelease = { delta: 0 };
        if (tickClaimLosses.length > 0 && workingTtForDamage) {
          for (const { eventId, lossesByUser } of tickClaimLosses) {
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
                  floatsState: workingTtForDamage,
                  threadId: t.id,
                  delta: dmgAmount,
                });
                if (dmg.deltaApplied <= 1e-9) continue;
                workingTtForDamage = dmg.floatsState;
                if (uid === pid) {
                  playerThreadStakeRelease.delta += dmg.deltaApplied;
                }
                // Layer 3: shrink the user's thread-derived B-book
                // stake by the damage amount (poolLayerDelta).
                if (workingBBookForDamage && dmg.poolLayerDelta > 0) {
                  const adj = adjustThreadDerived({
                    state: workingBBookForDamage,
                    uid,
                    delta: -dmg.poolLayerDelta,
                  });
                  if (adj.ok) workingBBookForDamage = adj.state;
                }
                // Layer 2: withdraw the per-market layer deltas. The
                // triggering market already wrote down via
                // settleMarketTick (claimOut); skip it to avoid
                // double-debit. Other covered markets need the cut
                // applied so the thread's layer-2 stays in sync.
                nextInsurance.markets = nextInsurance.markets.map((m) => {
                  const cut = dmg.insuranceLayerDeltas[m.eventId] ?? 0;
                  if (cut <= 1e-9) return m;
                  if (m.eventId === eventId) return m;
                  // Thread-damage propagation across covered markets —
                  // bypass lockup.
                  const r = withdrawInsurer({
                    market: m,
                    userId: uid,
                    amount: cut,
                    bypassLockup: true,
                  });
                  return r.ok ? r.market : m;
                });
                logs.push(
                  `[FLOAT-THREAD ${t.id}] insurance damage $${dmg.deltaApplied.toFixed(2)} (event ${eventId}) — all 4 layers shrunk`
                );
              }
            }
          }
        }

        if (workingTtForDamage !== floatsStateRef.current) {
          floatsStateRef.current = workingTtForDamage;
          sideEffects.nextTtState = workingTtForDamage;
        }
        if (workingBBookForDamage !== bBookStateRef.current) {
          bBookStateRef.current = workingBBookForDamage;
          sideEffects.nextBBookState = workingBBookForDamage;
        }
        if (playerThreadStakeRelease.delta > 0) {
          sideEffects.threadStakeRelease =
            (sideEffects.threadStakeRelease ?? 0) + playerThreadStakeRelease.delta;
        }

        sideEffects.nextInsuranceState = nextInsurance;
        insuranceStateRef.current = nextInsurance;

        const playerNet = playerCashChanges[pid] ?? 0;
        if (playerNet !== 0) {
          sideEffects.playerMarginDelta += playerNet;
        }
      }

      // -----------------------------------------------------------------
      // Float redemption cycle (thread-based)
      //
      // Runs on its own prime stride (REDEMPTION_EVERY) coprime with
      // analytics + insurance/LAP, ~monthly in sim-days. On each cycle:
      //   1. Merchant simulator queues 50% of its FLOAT balance for
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
      if (mediumCountRef.current % REDEMPTION_EVERY === 0 && floatsStateRef.current) {
        const tickEpoch = epochOfFirstPair(next);
        let workingTt = floatsStateRef.current;
        let workingInsurance = insuranceStateRef.current;

        // Step 1: merchant auto-redemption.
        if ((workingTt.merchantBalance ?? 0) > 1) {
          const merchantRedeem = workingTt.merchantBalance * 0.5;
          const submitted = submitFloatsRedemption({
            floatsState: workingTt,
            userId: "MERCHANT",
            amount: merchantRedeem,
            express: false,
            currentEpoch: tickEpoch,
          });
          if (submitted.ok) {
            workingTt = submitted.floatsState;
            logs.push(
              `[MERCHANT] queued ${merchantRedeem.toFixed(2)} FLOAT for redemption`
            );
          }
        }

        // Step 2: drain the queue.
        const cycle = runRedemptionCycle({
          floatsState: workingTt,
          currentEpoch: tickEpoch,
        });
        cycle.logs.forEach((l) => logs.push(l));
        workingTt = cycle.floatsState;

        // Step 3: apply per-thread unwinds. For each unwind:
        //   - withdraw the per-market insurance stakes (layer 2)
        //   - shrink the user's threadDerivedStake in the B-book pool
        //     by poolLayerDelta (layer 3)
        //   - release the minter's threadStake tag (local player only)
        let workingBBook = bBookStateRef.current;
        const threadStakeReleaseByOwner = {};
        for (const u of cycle.threadUnwinds) {
          if (workingInsurance && u.insuranceLayerDeltas) {
            workingInsurance = {
              ...workingInsurance,
              markets: workingInsurance.markets.map((m) => {
                const cut = u.insuranceLayerDeltas[m.eventId] ?? 0;
                if (cut <= 1e-9) return m;
                // FLOAT redemption thread unwind — bypass lockup
                // (redemption itself gates the user via the 10%
                // standard cap or 5% express penalty).
                const r = withdrawInsurer({
                  market: m,
                  userId: u.ownerId,
                  amount: cut,
                  bypassLockup: true,
                });
                return r.ok ? r.market : m;
              }),
            };
          }
          if (workingBBook && u.poolLayerDelta > 0) {
            const adj = adjustThreadDerived({
              state: workingBBook,
              uid: u.ownerId,
              delta: -u.poolLayerDelta,
            });
            if (adj.ok) workingBBook = adj.state;
          }
          threadStakeReleaseByOwner[u.ownerId] =
            (threadStakeReleaseByOwner[u.ownerId] ?? 0) + u.delta;
        }
        if (cycle.threadUnwinds.length > 0) {
          logs.push(
            `[FLOAT-UNWIND] ${cycle.threadUnwinds.length} thread(s) shrunk · total $${cycle.threadUnwinds
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
            `[FLOAT-PENALTY] $${cycle.penaltyToPool.toFixed(2)} routed to reinsurance sellers (split by coverageFraction)`
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
            floatsState: workingTt,
            userId: minterId,
          });
          workingTt = solvency.floatsState;
          if (solvency.clawback > 0 || solvency.newDebt > 0) {
            logs.push(
              `[FLOAT-SOLVENCY] ${minterId} clawback ${solvency.clawback.toFixed(2)} FLOAT, debt +${solvency.newDebt.toFixed(2)}`
            );
          }
        }

        sideEffects.threadStakeReleaseByOwner = threadStakeReleaseByOwner;

        sideEffects.nextTtState = workingTt;
        if (workingInsurance && workingInsurance !== insuranceStateRef.current) {
          sideEffects.nextInsuranceState = workingInsurance;
          insuranceStateRef.current = workingInsurance;
        }
        if (workingBBook && workingBBook !== bBookStateRef.current) {
          sideEffects.nextBBookState = workingBBook;
          bBookStateRef.current = workingBBook;
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
        setFloatsState(sideEffects.nextTtState);
        floatsStateRef.current = sideEffects.nextTtState;
      }
      if (sideEffects.nextInsuranceState) {
        setInsuranceState(sideEffects.nextInsuranceState);
        insuranceStateRef.current = sideEffects.nextInsuranceState;
      }
      if (sideEffects.nextBBookState && setBBookState) {
        setBBookState(sideEffects.nextBBookState);
        bBookStateRef.current = sideEffects.nextBBookState;
      }
      if (sideEffects.nextLapPoolState && setLapPoolState) {
        setLapPoolState(sideEffects.nextLapPoolState);
        lapPoolStateRef.current = sideEffects.nextLapPoolState;
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

      // Paired-LAP margin shrinks from rental defaults. (Thread-driven
      // LAP changes are gone — threads no longer hold paired LAPs as
      // layer 3; that role moved to the B-book pool.)
      const lapDeltas = {};
      for (const [lapId, add] of Object.entries(lapMarginAddByLapId)) {
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
            if (newMargin <= 1) continue; // drop dust
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
  }, [setPairStates, player, setPlayer, setLogs, addToast, setRoleLedger, setFloatsState, setInsuranceState, setBBookState, setLapPoolState, setOpenPositions, flowAdapter]);

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
