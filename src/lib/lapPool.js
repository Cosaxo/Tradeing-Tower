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
  BBOOK_LOCKUP_EPOCHS,    // we reuse the same lockup discipline
  BBOOK_MAX_NOTIONAL_RATIO, // and the same capacity gate
} from "../constants/system.js";

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
  const release = (currentEpoch ?? 0) + BBOOK_LOCKUP_EPOCHS;
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
//
// Capacity gate: total active notional after absorption stays ≤
// poolStake × BBOOK_MAX_NOTIONAL_RATIO. If a particular bid would
// breach, it's skipped and stays unmatched.
//
// Per absorbed contract, the pool earns the entropy-bonus tip:
//   tipReceived = bid.tip_tiers[0].tip × entMult(fillLev) × bid.base_margin
// This is added to cumulativeRebateIncome and distributed pro-rata to
// LP stakes in the apply phase (the loop calls distributeRebate).
//
// Returns:
//   { state, absorbedContracts, totalRebate }
export function absorbImbalance({
  state,
  unmatchedLongs = [],
  unmatchedShorts = [],
  normWeights = [],
  bucketLevs = [],
  openPrice,
  currentEpoch = 0,
}) {
  if (
    (unmatchedLongs.length === 0 && unmatchedShorts.length === 0) ||
    !Number.isFinite(openPrice) ||
    openPrice <= 0
  ) {
    return { state, absorbedContracts: [], totalRebate: 0 };
  }

  const stake = poolStake(state);
  if (stake <= 0) {
    return { state, absorbedContracts: [], totalRebate: 0 };
  }

  // The pool takes the OPPOSITE side of the surplus.
  const surplusBids = unmatchedLongs.length > 0 ? unmatchedLongs : unmatchedShorts;
  const poolSide = unmatchedLongs.length > 0 ? "SHORT" : "LONG";

  let workingState = state;
  const absorbedContracts = [];
  let totalRebate = 0;

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

    // Look up entropy multiplier for this bid's leverage. Safe default
    // = 1 if weights aren't supplied.
    const entMult = lookupEntropyMult(leverage, normWeights, bucketLevs);
    const tipRate = (bid.tip_tiers?.[0]?.tip ?? 0.02) * entMult;
    const tipReceived = margin * tipRate;
    totalRebate += tipReceived;

    const contract = {
      id: _uid("LAP-ABS"),
      absorbedUserId: bid.id,
      pairKey: bid.activePair ?? bid.pairKey ?? null,
      side: poolSide,
      leverage,
      margin,
      openPrice,
      openedAtEpoch: currentEpoch,
      tipReceived,
    };

    workingState = {
      ...workingState,
      activeAbsorbed: [...(workingState.activeAbsorbed ?? []), contract],
      contractCount: (workingState.contractCount ?? 0) + 1,
      cumulativeRebateIncome: (workingState.cumulativeRebateIncome ?? 0) + tipReceived,
    };
    absorbedContracts.push(contract);
  }

  return { state: workingState, absorbedContracts, totalRebate };
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

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function lookupEntropyMult(userLeverage, normWeights, bucketLevs) {
  if (!normWeights?.length || !bucketLevs?.length) return 1;
  let closest = 0;
  let minDist = Infinity;
  for (let i = 0; i < bucketLevs.length; i++) {
    const d = Math.abs(bucketLevs[i] - userLeverage);
    if (d < minDist) {
      minDist = d;
      closest = i;
    }
  }
  const avg = normWeights.reduce((s, w) => s + w, 0) / normWeights.length;
  return avg > 0 ? normWeights[closest] / avg : 1;
}
