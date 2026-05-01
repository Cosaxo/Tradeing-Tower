// B-book pool — opt-in counterparty for B-classified user flow.
//
// Why this exists
// ---------------
// CFD brokers traditionally B-book against their unprofitable customers
// without telling them. This protocol turns that hidden conflict of
// interest into a transparent open marketplace:
//
//   - Anyone can opt in to be a B-book underwriter by depositing
//     collateral. They earn the B-classified users' tip stream and
//     absorb the directional P&L of those users' positions.
//
//   - B-classified users (rolling-window losing traders, default for
//     new users) get their unmatched bids filled by the pool instead
//     of waiting for a peer counterparty.
//
//   - Every user can see their own classification + score.
//
// Economic shape
// --------------
// A B-book contract opens when a B-user's bid can't peer-match. The
// pool takes the OPPOSITE side. From the pool's perspective:
//
//   user goes LONG  → pool is effectively SHORT
//   user goes SHORT → pool is effectively LONG
//
// On close:
//
//   user_pnl = user_margin × user_lev × (exp(direction × logRet) − 1)
//
//   - user_pnl > 0 → pool pays user; underwriters lose pro-rata to stake
//   - user_pnl < 0 → user loses |user_pnl|; underwriters gain pro-rata
//
// User margin caps loss at 100% (same exp-floor as a peer-matched LAP).
// Underwriter risk is the user's potential WIN — theoretically unbounded
// in exp space, practically capped by leverage × the move. The pool
// guards via:
//
//   - MAX_NOTIONAL_RATIO: total active notional ≤ this × pool stake.
//     Refuses new contracts if breached.
//   - Underwriter lockup (BBOOK_LOCKUP_EPOCHS) so they can't flee
//     mid-loss.
//   - Whale exception (in userClassifier.routeFor): outsized bets get
//     force-classed to A regardless of score, preventing single-shot
//     drains.
//
// Two-sided B-routing self-cancels: a B-long and a B-short can pair
// directly through the pool (zero-net pool exposure, both filled). The
// caller (epoch loop) is responsible for matching B-long↔B-short
// before opening pool contracts.

import {
  BBOOK_MAX_NOTIONAL_RATIO,
  BBOOK_LOCKUP_EPOCHS,
} from "../constants/system.js";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initBBookState() {
  return {
    underwriters: {}, // { [uid]: { stake, depositedAtEpoch, lockupReleaseEpoch } }
    totalStake: 0,
    activeContracts: [],
    cumulativePoolPnl: 0,    // signed — positive means pool has won net
    cumulativeUserFlow: 0,   // total $ flowed user→pool (gross losses absorbed)
    contractCount: 0,        // lifetime count, for diagnostics
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function poolStake(state) {
  return state?.totalStake ?? 0;
}

export function totalActiveNotional(state) {
  return (state?.activeContracts ?? []).reduce(
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
  return state?.underwriters?.[uid]?.stake ?? 0;
}

export function activeContractsByUser(state, userId) {
  return (state?.activeContracts ?? []).filter((c) => c.userId === userId);
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
  // Latest deposit pushes the lockup release epoch out — prevents
  // drip-drip deposits from short-circuiting the lockup.
  const release = (currentEpoch ?? 0) + BBOOK_LOCKUP_EPOCHS;
  const nextEntry = {
    stake: (prev?.stake ?? 0) + amount,
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
  if (currentEpoch < u.lockupReleaseEpoch) {
    return {
      ok: false,
      reason: `locked until epoch ${u.lockupReleaseEpoch} (currently ${currentEpoch})`,
    };
  }
  if (amount > u.stake + 1e-9) {
    return { ok: false, reason: "amount exceeds stake" };
  }
  const newStake = u.stake - amount;
  const nextUnderwriters = { ...state.underwriters };
  if (newStake <= 1e-9) delete nextUnderwriters[uid];
  else nextUnderwriters[uid] = { ...u, stake: newStake };
  return {
    ok: true,
    state: {
      ...state,
      underwriters: nextUnderwriters,
      totalStake: Math.max(0, (state.totalStake ?? 0) - amount),
    },
  };
}

// ---------------------------------------------------------------------------
// Open / close contract
// ---------------------------------------------------------------------------

// Open a B-book contract. The user takes a directional position; the
// pool stands counterparty. Returns:
//
//   { ok, state, contract }       on success
//   { ok: false, reason }         on failure (e.g. pool over capacity)
//
// Capacity check: total active notional after opening must stay
// ≤ poolStake × MAX_NOTIONAL_RATIO. If breached, refuse — the loop
// then leaves the user's bid unmatched (degrades gracefully like an
// A-classified bid).
export function openContract({
  state,
  userId,
  pairKey,
  side,           // 'LONG' | 'SHORT'
  leverage,
  margin,
  openPrice,
  currentEpoch = 0,
}) {
  if (!userId || !pairKey) return { ok: false, reason: "missing user or pair" };
  if (side !== "LONG" && side !== "SHORT") {
    return { ok: false, reason: `invalid side ${side}` };
  }
  if (!Number.isFinite(margin) || margin <= 0) {
    return { ok: false, reason: "margin must be positive" };
  }
  if (!Number.isFinite(leverage) || leverage <= 0) {
    return { ok: false, reason: "leverage must be positive" };
  }
  if (!Number.isFinite(openPrice) || openPrice <= 0) {
    return { ok: false, reason: "openPrice must be positive" };
  }
  const stake = poolStake(state);
  if (stake <= 0) {
    return { ok: false, reason: "pool has no stake — no underwriters" };
  }
  const newNotional = totalActiveNotional(state) + margin * leverage;
  if (newNotional > stake * BBOOK_MAX_NOTIONAL_RATIO + 1e-9) {
    return {
      ok: false,
      reason: `pool capacity exceeded (would put utilisation at ${(newNotional / stake).toFixed(2)}× max ${BBOOK_MAX_NOTIONAL_RATIO})`,
    };
  }

  const contract = {
    id: _uid("BBC"),
    userId,
    pairKey,
    side,
    leverage,
    margin,
    openPrice,
    openedAtEpoch: currentEpoch,
  };
  return {
    ok: true,
    state: {
      ...state,
      activeContracts: [...(state.activeContracts ?? []), contract],
      contractCount: (state.contractCount ?? 0) + 1,
    },
    contract,
  };
}

// Compute the user's P&L on a B-book contract at `currentPrice`.
// Same exp-formula as a peer-matched LAP — ensures user sees identical
// payoff math whether they routed through peer or pool.
export function calcContractUserPnl(contract, currentPrice) {
  const direction = contract.side === "LONG" ? 1 : -1;
  const logRet = Math.log(currentPrice / contract.openPrice);
  const raw =
    contract.margin * contract.leverage * (Math.exp(direction * logRet) - 1);
  // User's loss capped at margin (exp form already enforces this
  // asymptotically; clamp for numerical safety).
  return Math.max(-contract.margin, raw);
}

// Close a B-book contract. Returns:
//
//   {
//     ok, state,
//     userPnl,                  // signed — what user gains (>0) or loses (<0)
//     poolPnl,                  // signed — what the pool gains (= -userPnl)
//     underwriterShares,        // { [uid]: signedDelta }
//   }
export function closeContract({ state, contractId, currentPrice }) {
  const idx = (state.activeContracts ?? []).findIndex((c) => c.id === contractId);
  if (idx < 0) return { ok: false, reason: "contract not found" };
  const c = state.activeContracts[idx];
  const userPnl = calcContractUserPnl(c, currentPrice);
  const poolPnl = -userPnl; // zero-sum versus user

  // Distribute poolPnl across underwriters pro-rata to their CURRENT
  // stake (snapshot at close). Stakes adjust by their share.
  const stake = poolStake(state);
  const underwriterShares = {};
  let nextUnderwriters = state.underwriters;
  if (stake > 0 && Math.abs(poolPnl) > 1e-9) {
    nextUnderwriters = { ...state.underwriters };
    for (const [uid, u] of Object.entries(state.underwriters ?? {})) {
      const share = u.stake / stake;
      const delta = poolPnl * share;
      underwriterShares[uid] = delta;
      nextUnderwriters[uid] = { ...u, stake: Math.max(0, u.stake + delta) };
    }
  }
  const newTotalStake = Math.max(
    0,
    Object.values(nextUnderwriters).reduce((s, u) => s + (u?.stake ?? 0), 0)
  );

  const remainingContracts = state.activeContracts.filter((_, i) => i !== idx);

  return {
    ok: true,
    state: {
      ...state,
      activeContracts: remainingContracts,
      underwriters: nextUnderwriters,
      totalStake: newTotalStake,
      cumulativePoolPnl: (state.cumulativePoolPnl ?? 0) + poolPnl,
      cumulativeUserFlow:
        (state.cumulativeUserFlow ?? 0) + (userPnl < 0 ? -userPnl : 0),
    },
    userPnl,
    poolPnl,
    underwriterShares,
  };
}

// ---------------------------------------------------------------------------
// Tick mark-to-market (no cash flow until close)
// ---------------------------------------------------------------------------

// Compute unrealized P&L per active contract. Used by the UI / loop
// for monitoring without triggering actual flows. Returns:
//
//   { totalUnrealizedUserPnl, totalUnrealizedPoolPnl, byContract: [{ id, userPnl }] }
export function markToMarket({ state, pricesByPair }) {
  const out = { byContract: [], totalUnrealizedUserPnl: 0, totalUnrealizedPoolPnl: 0 };
  for (const c of state.activeContracts ?? []) {
    const price = pricesByPair?.[c.pairKey];
    if (!Number.isFinite(price) || price <= 0) continue;
    const userPnl = calcContractUserPnl(c, price);
    out.byContract.push({ id: c.id, userId: c.userId, userPnl });
    out.totalUnrealizedUserPnl += userPnl;
    out.totalUnrealizedPoolPnl += -userPnl;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pre-pool B↔B matching
//
// Before opening contracts against the pool, the loop should match
// B-long bids against B-short bids directly. Same logic as the main
// auction's matchBids but scoped to B-classified flow only. Returns:
//
//   { matched: [{ longUserId, shortUserId, leverage, margin }],
//     remainingLongs, remainingShorts }
//
// Pairs by leverage proximity (sorted ascending on both sides, paired
// index-aligned). Continuous fill at min(longMax, shortMax) without
// the legacy sub-unit cascade.
// ---------------------------------------------------------------------------

export function matchBBookBids({ longBids = [], shortBids = [] }) {
  const matched = [];

  const sortedLongs = [...longBids].sort(
    (a, b) => (a.leverage ?? 0) - (b.leverage ?? 0)
  );
  const sortedShorts = [...shortBids].sort(
    (a, b) => (a.leverage ?? 0) - (b.leverage ?? 0)
  );

  const matchedLongIds = new Set();
  const matchedShortIds = new Set();
  const minPairs = Math.min(sortedLongs.length, sortedShorts.length);

  for (let i = 0; i < minPairs; i++) {
    const lb = sortedLongs[i];
    const sb = sortedShorts[i];
    const fillLev = Math.min(lb.leverage ?? 1, sb.leverage ?? 1);
    if (fillLev < 0.5) continue;
    const fillMargin = Math.min(lb.margin ?? 0, sb.margin ?? 0);
    if (fillMargin <= 0) continue;
    matched.push({
      longUserId: lb.userId,
      shortUserId: sb.userId,
      leverage: fillLev,
      margin: fillMargin,
      pairKey: lb.pairKey ?? sb.pairKey,
    });
    matchedLongIds.add(lb.id);
    matchedShortIds.add(sb.id);
  }

  return {
    matched,
    remainingLongs: longBids.filter((b) => !matchedLongIds.has(b.id)),
    remainingShorts: shortBids.filter((b) => !matchedShortIds.has(b.id)),
  };
}
