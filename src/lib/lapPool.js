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
  BBOOK_MAX_NOTIONAL_RATIO, // we reuse the same capacity gate as B-book
} from "../constants/system.js";
import { getEntropyMultForUser } from "./auction.js";

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
  const surplusBids = unmatchedLongs.length > 0 ? unmatchedLongs : unmatchedShorts;
  const poolSide = unmatchedLongs.length > 0 ? "SHORT" : "LONG";

  let workingState = state;
  const absorbedContracts = [];
  let totalRebate = 0;
  let rebateRequested = 0;
  const budget = Number.isFinite(rebateBudget) && rebateBudget > 0 ? rebateBudget : 0;

  for (const bid of surplusBids) {
    const margin = bid.base_margin ?? bid.margin ?? 0;
    const leverage = bid.max_lev ?? bid.leverage ?? 1;
    if (margin <= 0 || leverage < 0.5) continue;

    // Capacity check.
    const newNotional = totalActiveNotional(workingState) + margin * leverage;
    if (newNotional > stake * BBOOK_MAX_NOTIONAL_RATIO + 1e-9) {
      // Pool is full. Skip remaining bids; they stay unmatched.
      break;
    }

    // Look up entropy multiplier for this bid's leverage. Shared helper
    // with the auction so the absorbed and matched paths price tips
    // identically.
    const entMult = getEntropyMultForUser(leverage, normWeights, bucketLevs);
    const tipRate = (bid.tip_tiers?.[0]?.tip ?? 0.02) * entMult;
    const tipForBid = margin * tipRate;
    rebateRequested += tipForBid;

    // Funding gate. Without budget the pool would synthesize income
    // out of nothing; with budget exhausted we stop absorbing rather
    // than absorb-without-rebate (the rebate is the whole reason to
    // take the position).
    if (totalRebate + tipForBid > budget + 1e-9) {
      break;
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

// Distribute a tip-rebate income to LPs pro-rata to their total stake.
// Voluntary share goes to wallet (caller flushes to margin); thread-
// derived share compounds back into the thread (caller propagates via
// growThread).
//
// Returns: { state, lpShares: { [uid]: { total, voluntary, threadDerived } } }
export function distributeRebate({ state, totalRebate }) {
  if (!Number.isFinite(totalRebate) || totalRebate <= 0) {
    return { state, lpShares: {} };
  }
  const stake = poolStake(state);
  if (stake <= 0) return { state, lpShares: {} };

  const lpShares = {};
  let nextUnderwriters = { ...state.underwriters };
  for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
    const userTotal = (u.voluntaryStake ?? 0) + (u.threadDerivedStake ?? 0);
    if (userTotal <= 0) continue;
    const share = userTotal / stake;
    const delta = totalRebate * share;
    const vFrac = userTotal > 0 ? (u.voluntaryStake ?? 0) / userTotal : 0;
    const tFrac = 1 - vFrac;
    lpShares[uid] = {
      total: delta,
      voluntary: delta * vFrac,
      threadDerived: delta * tFrac,
    };
    // Stake amounts grow by the rebate proportionally.
    nextUnderwriters[uid] = {
      ...u,
      voluntaryStake: (u.voluntaryStake ?? 0) + delta * vFrac,
      threadDerivedStake: (u.threadDerivedStake ?? 0) + delta * tFrac,
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

// Per-tick maintenance pass. Closes any absorbed contract that has
// aged past `maxHoldEpochs` at the current per-pair price. Bounds
// directional exposure: even if opposite-side flow never returns, the
// pool's positions unwind within a known window.
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
}) {
  const contracts = state?.activeAbsorbed ?? [];
  if (contracts.length === 0) {
    return { state, closed: [], totalRealizedPnl: 0 };
  }

  const hold = Number.isFinite(maxHoldEpochs) && maxHoldEpochs > 0 ? maxHoldEpochs : Infinity;

  let workingState = state;
  const closed = [];
  let totalRealizedPnl = 0;

  // Iterate over a snapshot so closeAbsorbed can mutate workingState's
  // activeAbsorbed array without invalidating the loop.
  const snapshot = contracts.map((c) => ({
    id: c.id,
    pairKey: c.pairKey,
    age: currentEpoch - (c.openedAtEpoch ?? currentEpoch),
  }));

  for (const { id, pairKey, age } of snapshot) {
    if (age < hold) continue;

    const price = pricesByPair?.[pairKey];
    if (!Number.isFinite(price) || price <= 0) continue;

    const original = contracts.find((c) => c.id === id);
    const r = closeAbsorbed({ state: workingState, contractId: id, currentPrice: price });
    if (!r.ok) continue;

    workingState = r.state;
    totalRealizedPnl += r.poolPnl;
    closed.push({
      contract: original,
      poolPnl: r.poolPnl,
      underwriterShares: r.underwriterShares ?? {},
      reason: "aged",
    });
  }

  return { state: workingState, closed, totalRealizedPnl };
}

// Close an absorbed contract — distribute realised P&L to LPs.
// Same shape as bBookPool.closeContract.
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
    for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
      const userTotal = (u.voluntaryStake ?? 0) + (u.threadDerivedStake ?? 0);
      if (userTotal <= 0) continue;
      const share = userTotal / stake;
      const delta = poolPnl * share;
      const vFrac = userTotal > 0 ? (u.voluntaryStake ?? 0) / userTotal : 0;
      const tFrac = 1 - vFrac;
      const dV = delta * vFrac;
      const dT = delta * tFrac;
      underwriterShares[uid] = {
        total: delta,
        voluntary: dV,
        threadDerived: dT,
      };
      nextUnderwriters[uid] = {
        ...u,
        voluntaryStake: Math.max(0, (u.voluntaryStake ?? 0) + dV),
        threadDerivedStake: Math.max(0, (u.threadDerivedStake ?? 0) + dT),
      };
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

