// LAP pool — passive market-maker for the LAP auction.
//
// Why this exists
// ---------------
// The default Tier-3 role for a Hyperfloat user should be passive. They
// shouldn't have to actively trade to earn from layer 3. The B-book pool
// (lib/bBookPool.js) addresses one slice of this: classifier-routed
// retail user trades. The LAP pool addresses the other slice: book
// imbalance.
//
// Each medium tick the auction (lib/auction.js) produces matched pairs
// plus unmatched flow. The unmatched flow is structural — when there
// are more longs than shorts (or vice versa), the surplus side has no
// counterparty. Without intervention, those positions sit unfilled and
// the would-be matched tips go uncollected.
//
// The LAP pool fills this gap: it stands as a synthetic counterparty
// for the surplus side. Concretely:
//
//   - Pool absorbs N unmatched contracts on the surplus side
//   - Each absorbed contract earns the entropy-rebate tip rate (because
//     the surplus side is by definition over-supplied, the under-supplied
//     side they would have matched against gets the rebate)
//   - The pool's resulting position has directional exposure (opposite
//     of the surplus side)
//   - When prices move, directional P&L flows between the absorbed user
//     and the pool, distributed pro-rata to LP stakeholders
//
// Net economic outcome for LPs:
//   - +tip income (deterministic, scales with imbalance × match volume)
//   - +/- directional P&L (zero-mean assuming the imbalance bias is a
//     short-term sentiment swing rather than an information edge)
//   - Net: positive expected yield from the rebate, with bounded
//     directional risk
//
// This is the *passive* counterpart to the B-book pool's *opt-in*
// underwriter role. Both share the same data shape (voluntary +
// thread-derived stake, P&L distribution pro-rata, lockup mechanics).

import {
  LAP_POOL_LOCKUP_EPOCHS,
  LAP_POOL_VOLUNTARY_YIELD_BONUS,
  LAP_POOL_REBATE_FEE_SHARE_MAX,
  LAP_POOL_REBATE_FEE_SHARE_MIN,
  BBOOK_MAX_NOTIONAL_RATIO, // we reuse the same capacity gate as B-book
} from "../constants/system.js";
import { getEntropyMultForUser } from "./auction.js";
import { routeFor } from "./userClassifier.js";

// ---------------------------------------------------------------------------
// Adaptive capacity sizing
// ---------------------------------------------------------------------------

// Reference per-tick sigma for the capacity-ratio calibration. Markets
// realising this sigma get the full base cap; sigma higher than this
// scales the cap down inversely; sigma lower scales up but is clamped.
const REFERENCE_SIGMA = 0.005;

// Clamp the adaptive multiplier so it can't go below this fraction of
// the base cap even in extreme vol — keeps the pool useful, just on a
// tighter leash.
const ADAPTIVE_FLOOR = 0.4;

// Scale the static notional cap down when realised volatility is high.
//
// effective = base × clamp(REFERENCE_SIGMA / realizedSigma, ADAPTIVE_FLOOR, 1.0)
//
// At REFERENCE_SIGMA the multiplier is 1.0 (full base cap). At 2×
// REFERENCE_SIGMA the multiplier is 0.5 → half cap. The upper clamp at
// 1.0 means low-vol regimes don't *expand* the cap above the static
// value (the static value is already a safety boundary; vol calm is no
// reason to loosen it).
export function effectiveNotionalRatio(realizedSigma, baseRatio = BBOOK_MAX_NOTIONAL_RATIO) {
  if (!Number.isFinite(realizedSigma) || realizedSigma <= 0) return baseRatio;
  const factor = REFERENCE_SIGMA / realizedSigma;
  const clamped = Math.min(1.0, Math.max(ADAPTIVE_FLOOR, factor));
  return baseRatio * clamped;
}

// Dynamic rebate-fee share: scales the pool's draw on stability fees
// from MAX (empty pool — fresh LPs need bigger incentive to deposit)
// down to MIN (full pool — existing LPs are already earning fully and
// the protocol can keep more of the fee).
//
// Utilisation is normalised so 0 = empty pool, 1 = at the capacity cap.
// Linear interpolation. Above the cap (rare; means an unwind is
// imminent) we hold at MIN.
//
// share(0) = MAX, share(1) = MIN.
//
// The reviewer flagged hardcoding 70/30 as a governance liability; this
// makes the parameter self-calibrating around the static midpoint.
export function dynamicRebateFeeShare({
  utilization,
  min = LAP_POOL_REBATE_FEE_SHARE_MIN,
  max = LAP_POOL_REBATE_FEE_SHARE_MAX,
}) {
  if (!Number.isFinite(utilization) || utilization <= 0) return max;
  const u = Math.min(1, utilization);
  return max + (min - max) * u; // u=0 → max, u=1 → min
}

// Convenience: compute utilisation as a 0–1 fraction of the cap.
// Returns 0 for empty pools (no stake → no utilisation defined; we
// treat this as "needs LPs" → triggers max share via the interpolator).
export function poolUtilizationFraction(state, maxNotionalRatio = BBOOK_MAX_NOTIONAL_RATIO) {
  const stake = poolStake(state);
  if (stake <= 0) return 0;
  const cap = stake * maxNotionalRatio;
  if (cap <= 0) return 0;
  return totalActiveNotional(state) / cap;
}

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

// Underwriter capital: same two-portion split as the B-book pool.
//
//   voluntaryStake     — opt-in stake from the LapPoolDesk; lockup
//                        applies; withdraws to wallet.
//   threadDerivedStake — the user's thread layer-3 stake when minting
//                        TT routes a portion to the LAP pool (the
//                        Path-A default split). Not subject to per-stake
//                        lockup — gated by thread redemption mechanics.
//
// totalStake = sum of both portions across all underwriters.
export function initLapPoolState() {
  return {
    underwriters: {},
    totalStake: 0,
    activeAbsorbed: [],         // contracts the pool has taken
    cumulativeRebateIncome: 0,  // sum of tip income earned (positive)
    cumulativePoolPnl: 0,       // signed; directional P&L from absorbed positions
    cumulativeUserFlow: 0,      // gross losses absorbed from absorbed-user side
    contractCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function poolStake(state) {
  return state?.totalStake ?? 0;
}

export function totalActiveNotional(state) {
  return (state?.activeAbsorbed ?? []).reduce(
    (s, c) => s + (c.margin ?? 0) * (c.leverage ?? 1),
    0
  );
}

export function poolUtilization(state) {
  const stake = poolStake(state);
  if (stake <= 0) return 0;
  return totalActiveNotional(state) / stake;
}

export function underwriterStake(state, uid) {
  const u = state?.underwriters?.[uid];
  if (!u) return 0;
  return (u.voluntaryStake ?? 0) + (u.threadDerivedStake ?? 0);
}

export function voluntaryStakeOf(state, uid) {
  return state?.underwriters?.[uid]?.voluntaryStake ?? 0;
}

export function threadDerivedStakeOf(state, uid) {
  return state?.underwriters?.[uid]?.threadDerivedStake ?? 0;
}

// ---------------------------------------------------------------------------
// Underwriter deposit / withdraw
// ---------------------------------------------------------------------------

export function depositUnderwriter({ state, uid, amount, currentEpoch = 0 }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  if (!uid) return { ok: false, reason: "no uid" };
  const prev = state.underwriters?.[uid];
  const release = (currentEpoch ?? 0) + LAP_POOL_LOCKUP_EPOCHS;
  const nextEntry = {
    voluntaryStake: (prev?.voluntaryStake ?? 0) + amount,
    threadDerivedStake: prev?.threadDerivedStake ?? 0,
    depositedAtEpoch: currentEpoch,
    lockupReleaseEpoch: Math.max(prev?.lockupReleaseEpoch ?? 0, release),
  };
  return {
    ok: true,
    state: {
      ...state,
      underwriters: { ...state.underwriters, [uid]: nextEntry },
      totalStake: (state.totalStake ?? 0) + amount,
    },
  };
}

export function withdrawUnderwriter({ state, uid, amount, currentEpoch = 0 }) {
  const u = state.underwriters?.[uid];
  if (!u) return { ok: false, reason: "no underwriter record" };
  if (currentEpoch < (u.lockupReleaseEpoch ?? 0)) {
    return {
      ok: false,
      reason: `locked until epoch ${u.lockupReleaseEpoch} (currently ${currentEpoch})`,
    };
  }
  const voluntary = u.voluntaryStake ?? 0;
  if (amount > voluntary + 1e-9) {
    return {
      ok: false,
      reason: `amount exceeds voluntary stake (have $${voluntary.toFixed(2)}; thread-derived $${(u.threadDerivedStake ?? 0).toFixed(2)} is locked by thread)`,
    };
  }
  const nextVoluntary = voluntary - amount;
  const threadDerived = u.threadDerivedStake ?? 0;
  const nextUnderwriters = { ...state.underwriters };
  if (nextVoluntary + threadDerived <= 1e-9) {
    delete nextUnderwriters[uid];
  } else {
    nextUnderwriters[uid] = { ...u, voluntaryStake: nextVoluntary };
  }
  return {
    ok: true,
    state: {
      ...state,
      underwriters: nextUnderwriters,
      totalStake: Math.max(0, (state.totalStake ?? 0) - amount),
    },
  };
}

export function adjustThreadDerived({ state, uid, delta }) {
  if (!Number.isFinite(delta) || delta === 0) {
    return { ok: true, state };
  }
  const u = state.underwriters?.[uid];
  if (delta < 0) {
    if (!u) return { ok: false, reason: "no underwriter record" };
    const have = u.threadDerivedStake ?? 0;
    if (-delta > have + 1e-9) {
      return { ok: false, reason: "delta exceeds thread-derived stake" };
    }
  }
  const prev = u ?? {
    voluntaryStake: 0,
    threadDerivedStake: 0,
    depositedAtEpoch: 0,
    lockupReleaseEpoch: 0,
  };
  const nextThreadDerived = Math.max(0, (prev.threadDerivedStake ?? 0) + delta);
  const nextEntry = { ...prev, threadDerivedStake: nextThreadDerived };
  const totalForUser = (nextEntry.voluntaryStake ?? 0) + nextThreadDerived;
  const nextUnderwriters = { ...state.underwriters };
  if (totalForUser <= 1e-9) delete nextUnderwriters[uid];
  else nextUnderwriters[uid] = nextEntry;
  return {
    ok: true,
    state: {
      ...state,
      underwriters: nextUnderwriters,
      totalStake: Math.max(0, (state.totalStake ?? 0) + delta),
    },
  };
}

// ---------------------------------------------------------------------------
// Imbalance absorption — the pool's primary economic role
// ---------------------------------------------------------------------------

// Given the auction's unmatched flow + the entropy weights from the same
// auction, the pool steps in as the synthetic counterparty for as much
// of the imbalance as its capacity allows.
//
// Inputs:
//   state         — current pool state
//   unmatchedLongs — bids on the long side that didn't match
//   unmatchedShorts — bids on the short side that didn't match
//                    (one of these will be empty in any imbalanced
//                    auction; both empty → no work)
//   normWeights, bucketLevs — entropy weight lookup tables from the
//                             same auction tick
//   openPrice     — current price (used as the absorbed-contract's open)
//   currentEpoch
//   rebateBudget  — REQUIRED real-money funding cap. The caller (the
//                   epoch loop) decides how much of the per-tick stability
//                   fee the pool may draw on; absorption stops once the
//                   accumulated tip income would exceed this budget. This
//                   is the conservation discipline — no rebate without a
//                   matching debit on the protocol fee ledger.
//
// Capacity gate: total active notional after absorption stays ≤
// poolStake × BBOOK_MAX_NOTIONAL_RATIO. If a particular bid would
// breach, it's skipped and stays unmatched.
//
// Returns:
//   { state, absorbedContracts, totalRebate, rebateRequested }
//   - totalRebate   = funded rebate (≤ rebateBudget)
//   - rebateRequested = what would have been earned with infinite budget
//                       (useful telemetry for tuning the budget)
export function absorbImbalance({
  state,
  unmatchedLongs = [],
  unmatchedShorts = [],
  normWeights = [],
  bucketLevs = [],
  openPrice,
  currentEpoch = 0,
  rebateBudget = 0,
  maxNotionalRatio = BBOOK_MAX_NOTIONAL_RATIO,
  classifierState = null,
}) {
  if (
    (unmatchedLongs.length === 0 && unmatchedShorts.length === 0) ||
    !Number.isFinite(openPrice) ||
    openPrice <= 0
  ) {
    return { state, absorbedContracts: [], totalRebate: 0, rebateRequested: 0 };
  }

  const stake = poolStake(state);
  if (stake <= 0) {
    return { state, absorbedContracts: [], totalRebate: 0, rebateRequested: 0 };
  }

  // The pool takes the OPPOSITE side of the surplus.
  const rawSurplusBids = unmatchedLongs.length > 0 ? unmatchedLongs : unmatchedShorts;
  const poolSide = unmatchedLongs.length > 0 ? "SHORT" : "LONG";

  // Adverse-selection filter: A-classified (skilled) bids on the
  // minority side are *informed* flow, not just structurally
  // imbalanced. Absorbing them systematically loses for the pool —
  // they're the same flow the B-book classifier protects against on
  // the active-trader path. We exclude them here so they remain
  // unmatched (forced to find a peer counterparty in the next tick or
  // via the rental market). B-classified and unknown-default users
  // continue to be absorbed.
  //
  // If no classifierState is supplied, no filtering happens — the
  // pool absorbs everything as before. This preserves backward
  // compatibility for callers that don't have the classifier wired in
  // (the harness, NPC adapters in raw form).
  const surplusBids = classifierState
    ? rawSurplusBids.filter((bid) => {
        const route = routeFor({
          state: classifierState,
          userId: bid.id,
          positionMargin: bid.base_margin ?? bid.margin ?? 0,
        });
        return route !== "A";
      })
    : rawSurplusBids;

  // Sort bids by expected rebate income (descending) before iterating.
  // Without this, the function processes bids in their adapter-arrival
  // order, which means an adversary flooding the order book with
  // low-tip / poorly-priced bids early in the tick can consume the
  // pool's capacity before higher-quality bids are seen.
  //
  // By sorting first, capacity-constrained absorption picks the
  // best-paying bids first regardless of arrival order. Conservation
  // is unchanged (the same budget gates apply); throughput per dollar
  // of risk is improved.
  const ranked = [];
  for (const bid of surplusBids) {
    const margin = bid.base_margin ?? bid.margin ?? 0;
    const leverage = bid.max_lev ?? bid.leverage ?? 1;
    if (margin <= 0 || leverage < 0.5) continue;
    const entMult = getEntropyMultForUser(leverage, normWeights, bucketLevs);
    const tipRate = (bid.tip_tiers?.[0]?.tip ?? 0.02) * entMult;
    const tipForBid = margin * tipRate;
    ranked.push({ bid, margin, leverage, tipForBid });
  }
  ranked.sort((a, b) => b.tipForBid - a.tipForBid);

  let workingState = state;
  const absorbedContracts = [];
  let totalRebate = 0;
  let rebateRequested = 0;
  const budget = Number.isFinite(rebateBudget) && rebateBudget > 0 ? rebateBudget : 0;

  for (const { bid, margin, leverage, tipForBid } of ranked) {
    // Capacity check. The cap is parameterised so callers can supply
    // a vol-adaptive value (effectiveNotionalRatio); defaults to the
    // static BBOOK_MAX_NOTIONAL_RATIO.
    const newNotional = totalActiveNotional(workingState) + margin * leverage;
    if (newNotional > stake * maxNotionalRatio + 1e-9) {
      // This bid doesn't fit; remaining (smaller-notional) bids in the
      // ranked list might still — keep going rather than break.
      continue;
    }

    rebateRequested += tipForBid;

    // Funding gate. Without budget the pool would synthesize income
    // out of nothing; with budget exhausted we stop absorbing rather
    // than absorb-without-rebate (the rebate is the whole reason to
    // take the position).
    if (totalRebate + tipForBid > budget + 1e-9) {
      continue;
    }
    totalRebate += tipForBid;

    const contract = {
      id: _uid("LAP-ABS"),
      absorbedUserId: bid.id,
      pairKey: bid.activePair ?? bid.pairKey ?? null,
      side: poolSide,
      leverage,
      margin,
      openPrice,
      openedAtEpoch: currentEpoch,
      tipReceived: tipForBid,
    };

    workingState = {
      ...workingState,
      activeAbsorbed: [...(workingState.activeAbsorbed ?? []), contract],
      contractCount: (workingState.contractCount ?? 0) + 1,
      cumulativeRebateIncome: (workingState.cumulativeRebateIncome ?? 0) + tipForBid,
    };
    absorbedContracts.push(contract);
  }

  return { state: workingState, absorbedContracts, totalRebate, rebateRequested };
}

// Compute the weighted total for the junior/senior distribution. The
// "weight" of a stake is what determines its share when income is
// distributed; voluntary stake gets the LAP_POOL_VOLUNTARY_YIELD_BONUS
// multiplier above thread-derived.
//
// Returns:
//   { weightedPool, perUser: { [uid]: { weightedV, weightedT, weightedTotal } } }
function computeWeightedShares(state) {
  const perUser = {};
  let weightedPool = 0;
  for (const [uid, u] of Object.entries(state?.underwriters ?? {})) {
    const v = u.voluntaryStake ?? 0;
    const t = u.threadDerivedStake ?? 0;
    if (v + t <= 0) continue;
    const wV = v * LAP_POOL_VOLUNTARY_YIELD_BONUS;
    const wT = t;
    perUser[uid] = { weightedV: wV, weightedT: wT, weightedTotal: wV + wT };
    weightedPool += wV + wT;
  }
  return { weightedPool, perUser };
}

// Distribute a positive cashflow (rebate income or positive close P&L)
// to LPs using the weighted distribution. Voluntary stake earns at a
// yield bonus over thread-derived, compensating voluntary LPs for the
// junior-tranche loss exposure.
//
// Voluntary share goes to wallet (caller flushes to margin); thread-
// derived share compounds back into the thread (caller propagates via
// growThread).
//
// Returns: { state, lpShares: { [uid]: { total, voluntary, threadDerived } } }
export function distributeRebate({ state, totalRebate }) {
  if (!Number.isFinite(totalRebate) || totalRebate <= 0) {
    return { state, lpShares: {} };
  }
  if (poolStake(state) <= 0) return { state, lpShares: {} };

  const { weightedPool, perUser } = computeWeightedShares(state);
  if (weightedPool <= 0) return { state, lpShares: {} };

  const lpShares = {};
  const nextUnderwriters = { ...state.underwriters };
  for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
    const w = perUser[uid];
    if (!w) continue;
    // Within-user split: voluntary gets its weighted-V share of the
    // user's total, thread-derived gets weighted-T share.
    const userTotalDelta = totalRebate * (w.weightedTotal / weightedPool);
    const dV = userTotalDelta * (w.weightedV / w.weightedTotal);
    const dT = userTotalDelta - dV;
    lpShares[uid] = {
      total: userTotalDelta,
      voluntary: dV,
      threadDerived: dT,
    };
    nextUnderwriters[uid] = {
      ...u,
      voluntaryStake: (u.voluntaryStake ?? 0) + dV,
      threadDerivedStake: (u.threadDerivedStake ?? 0) + dT,
    };
  }
  const newTotalStake = Math.max(
    0,
    Object.values(nextUnderwriters).reduce(
      (s, u) => s + (u?.voluntaryStake ?? 0) + (u?.threadDerivedStake ?? 0),
      0
    )
  );
  return {
    state: {
      ...state,
      underwriters: nextUnderwriters,
      totalStake: newTotalStake,
    },
    lpShares,
  };
}

// ---------------------------------------------------------------------------
// Mark-to-market on absorbed positions
// ---------------------------------------------------------------------------

// P&L on a single absorbed contract at currentPrice. Mirror of
// calcContractUserPnl in bBookPool.js but from the POOL's perspective
// (which is the opposite side of the absorbed user).
export function calcContractPoolPnl(contract, currentPrice) {
  // Pool side is opposite of absorbed user. If pool is SHORT, pool
  // gains when price falls.
  const direction = contract.side === "LONG" ? 1 : -1;
  const logRet = Math.log(currentPrice / contract.openPrice);
  const raw =
    contract.margin * contract.leverage * (Math.exp(direction * logRet) - 1);
  // Cap loss at the absorbed user's posted margin (since they can't
  // pay more than that).
  return Math.max(-contract.margin, raw);
}

export function markToMarket({ state, pricesByPair }) {
  const out = { byContract: [], totalUnrealizedPoolPnl: 0 };
  for (const c of state.activeAbsorbed ?? []) {
    const price = pricesByPair?.[c.pairKey];
    if (!Number.isFinite(price) || price <= 0) continue;
    const poolPnl = calcContractPoolPnl(c, price);
    out.byContract.push({ id: c.id, poolPnl });
    out.totalUnrealizedPoolPnl += poolPnl;
  }
  return out;
}

// Per-tick maintenance pass. Two phases run in order:
//
// 1. Aged-out closes — any contract whose age ≥ maxHoldEpochs is
//    closed at the current pair price. Bounds directional exposure to
//    a known window.
//
// 2. Emergency unwind on capacity breach — if after the aged closes
//    the pool's utilisation is still over BBOOK_MAX_NOTIONAL_RATIO
//    (e.g., because thread-derived stake was redeemed faster than
//    aged closes freed notional — the thundering-herd scenario),
//    close the oldest remaining contracts until utilisation is back
//    under cap. Each forced close has reason="capacityBreach".
//
// Returns:
//   { state, closed: [{ contract, poolPnl, underwriterShares, reason }],
//     totalRealizedPnl }
//
// Each entry's `underwriterShares` mirrors `closeAbsorbed`'s shape so
// the caller can run damageThread / growThread for thread-derived
// portions in lockstep with the rest of the protocol.
export function maintainAbsorbed({
  state,
  pricesByPair = {},
  currentEpoch = 0,
  maxHoldEpochs,
  maxNotionalRatio = BBOOK_MAX_NOTIONAL_RATIO,
}) {
  const initialContracts = state?.activeAbsorbed ?? [];
  if (initialContracts.length === 0) {
    return { state, closed: [], totalRealizedPnl: 0 };
  }

  const hold = Number.isFinite(maxHoldEpochs) && maxHoldEpochs > 0 ? maxHoldEpochs : Infinity;

  let workingState = state;
  const closed = [];
  let totalRealizedPnl = 0;

  const closeOne = (id, pairKey, reason) => {
    const price = pricesByPair?.[pairKey];
    if (!Number.isFinite(price) || price <= 0) return false;
    const original = (workingState.activeAbsorbed ?? []).find((c) => c.id === id);
    const r = closeAbsorbed({ state: workingState, contractId: id, currentPrice: price });
    if (!r.ok) return false;
    workingState = r.state;
    totalRealizedPnl += r.poolPnl;
    closed.push({
      contract: original,
      poolPnl: r.poolPnl,
      underwriterShares: r.underwriterShares ?? {},
      reason,
    });
    return true;
  };

  // Phase 1: aged closes. Iterate over a snapshot so closeAbsorbed can
  // mutate workingState.activeAbsorbed without invalidating the loop.
  const aged = initialContracts
    .map((c) => ({
      id: c.id,
      pairKey: c.pairKey,
      age: currentEpoch - (c.openedAtEpoch ?? currentEpoch),
    }))
    .filter((c) => c.age >= hold);
  for (const { id, pairKey } of aged) {
    closeOne(id, pairKey, "aged");
  }

  // Phase 2: emergency unwind on capacity breach. If utilisation is
  // still over the cap, close oldest remaining contracts until it isn't.
  // Sorted by openedAtEpoch ascending so oldest go first (FIFO unwind).
  const capacityCap = (workingState.totalStake ?? 0) * maxNotionalRatio;
  if (totalActiveNotional(workingState) > capacityCap + 1e-9) {
    const remaining = [...(workingState.activeAbsorbed ?? [])].sort(
      (a, b) => (a.openedAtEpoch ?? 0) - (b.openedAtEpoch ?? 0)
    );
    for (const c of remaining) {
      if (totalActiveNotional(workingState) <= (workingState.totalStake ?? 0) * maxNotionalRatio + 1e-9) {
        break;
      }
      closeOne(c.id, c.pairKey, "capacityBreach");
    }
  }

  return { state: workingState, closed, totalRealizedPnl };
}

// Close an absorbed contract — distribute realised P&L to LPs with
// junior/senior tranching:
//
//   - Gains (poolPnl > 0): weighted distribution favouring voluntary
//     (yield bonus = LAP_POOL_VOLUNTARY_YIELD_BONUS).
//   - Losses (poolPnl < 0): voluntary stake absorbs first as a class.
//     If the total loss exceeds total voluntary stake, the residual
//     spreads to thread-derived stake. Within each tranche,
//     distribution is pro-rata.
//
// This makes voluntary the junior tranche (higher yield, first-loss)
// and thread-derived the senior tranche (lower yield, loss-protected).
// Without it, users who minted FLOAT for the stablecoin face the same
// downside as users who explicitly opted in as LAP-pool LPs — an
// asymmetry the deep-dive review flagged as a real PR/legal risk.
export function closeAbsorbed({ state, contractId, currentPrice }) {
  const idx = (state.activeAbsorbed ?? []).findIndex((c) => c.id === contractId);
  if (idx < 0) return { ok: false, reason: "absorbed contract not found" };
  const c = state.activeAbsorbed[idx];
  const poolPnl = calcContractPoolPnl(c, currentPrice);

  const stake = poolStake(state);
  const underwriterShares = {};
  let nextUnderwriters = state.underwriters;

  if (stake > 0 && Math.abs(poolPnl) > 1e-9) {
    nextUnderwriters = { ...state.underwriters };

    if (poolPnl > 0) {
      // Gain — weighted distribution (voluntary gets the yield bonus).
      const { weightedPool, perUser } = computeWeightedShares(state);
      if (weightedPool > 0) {
        for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
          const w = perUser[uid];
          if (!w) continue;
          const userTotalDelta = poolPnl * (w.weightedTotal / weightedPool);
          const dV = userTotalDelta * (w.weightedV / w.weightedTotal);
          const dT = userTotalDelta - dV;
          underwriterShares[uid] = { total: userTotalDelta, voluntary: dV, threadDerived: dT };
          nextUnderwriters[uid] = {
            ...u,
            voluntaryStake: Math.max(0, (u.voluntaryStake ?? 0) + dV),
            threadDerivedStake: Math.max(0, (u.threadDerivedStake ?? 0) + dT),
          };
        }
      }
    } else {
      // Loss — voluntary tranche absorbs first.
      const totalLoss = -poolPnl; // positive
      let totalVoluntary = 0;
      let totalThreadDerived = 0;
      for (const u of Object.values(state.underwriters ?? {})) {
        totalVoluntary += u?.voluntaryStake ?? 0;
        totalThreadDerived += u?.threadDerivedStake ?? 0;
      }
      const lossToVoluntary = Math.min(totalLoss, totalVoluntary);
      const lossToThreadDerived = Math.max(0, totalLoss - totalVoluntary);

      for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
        const v = u.voluntaryStake ?? 0;
        const t = u.threadDerivedStake ?? 0;
        if (v + t <= 0) continue;
        const dV =
          totalVoluntary > 0 && lossToVoluntary > 0
            ? -(v / totalVoluntary) * lossToVoluntary
            : 0;
        const dT =
          totalThreadDerived > 0 && lossToThreadDerived > 0
            ? -(t / totalThreadDerived) * lossToThreadDerived
            : 0;
        if (dV === 0 && dT === 0) continue;
        underwriterShares[uid] = { total: dV + dT, voluntary: dV, threadDerived: dT };
        nextUnderwriters[uid] = {
          ...u,
          voluntaryStake: Math.max(0, v + dV),
          threadDerivedStake: Math.max(0, t + dT),
        };
      }
    }
  }
  const newTotalStake = Math.max(
    0,
    Object.values(nextUnderwriters).reduce(
      (s, u) => s + (u?.voluntaryStake ?? 0) + (u?.threadDerivedStake ?? 0),
      0
    )
  );
  const remainingContracts = state.activeAbsorbed.filter((_, i) => i !== idx);

  return {
    ok: true,
    state: {
      ...state,
      activeAbsorbed: remainingContracts,
      underwriters: nextUnderwriters,
      totalStake: newTotalStake,
      cumulativePoolPnl: (state.cumulativePoolPnl ?? 0) + poolPnl,
      cumulativeUserFlow:
        (state.cumulativeUserFlow ?? 0) + (poolPnl > 0 ? poolPnl : 0),
    },
    poolPnl,
    underwriterShares,
  };
}

