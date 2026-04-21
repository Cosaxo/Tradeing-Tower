// Dominant-pool settlement with risk-weighted cascade tiers (whitepaper §5.2).
//
// Positions are sorted by riskScore and split into three isolated tiers:
//   SAFE   — bottom 40%, settles first, bounded losses
//   MEDIUM — middle 30%
//   RISKY  — top 30%, settles last, stability fee applied
//
// Within each tier, payouts are distributed by safety-weight-adjusted share:
//
//   adjShare_i = (m_i · 1/riskScore_i) / Σ (m_j · 1/riskScore_j)
//
// Correlation penalty is hedgeChar-aware: positions whose book hedges in the
// opposite crisis direction get a discount; two equity indices with both
// hedgeChar<0 get the full penalty.
//
// Tips are ESCROWED separately before the cascade runs — minority yield is
// guaranteed regardless of cascade outcomes.

import { geometricPnl, deterministicBarrierAdjustment } from "./settlement.js";
import { TBILL_RATE } from "../constants/system.js";
import { PAIRS } from "../constants/assets.js";
import { getPairCorr } from "./correlation.js";

// Whitepaper §5.2 — 40/30/30 tier split.
const TIER_SPLIT = { SAFE: 0.40, MEDIUM: 0.70 }; // cumulative breakpoints

// HedgeChar-aware correlation penalty (§5.2):
//   corrPenalty_i = max(0.75, 1 + 1/n · Σ ρ_{i,j} · (1 − h_i · h_j) · 0.5)
// Gold+SPX (hedgeChar 0.6, -0.3 → 1 - (-0.18) = 1.18) amplifies penalty downward
// i.e. they get a discount. Two equity indices (both negative) get full penalty.
export function calcHedgeCorrPenalty(user, allUsers, corrMap, getPairKey = (u) => u.pairKey) {
  const pairA = getPairKey(user);
  const hA = PAIRS[pairA]?.hedgeChar ?? 0;
  const others = allUsers.filter((u) => u.id !== user.id);
  if (others.length === 0) return 1;
  let sum = 0;
  let count = 0;
  for (const other of others) {
    const pairB = getPairKey(other);
    if (!pairB || pairA === pairB) continue;
    const rho = getPairCorr(corrMap ?? {}, pairA, pairB);
    const hB = PAIRS[pairB]?.hedgeChar ?? 0;
    sum += rho * (1 - hA * hB) * 0.5;
    count += 1;
  }
  const penalty = count > 0 ? 1 + sum / count : 1;
  return Math.max(0.75, penalty);
}

// Risk score: higher = more dangerous to the pool.
export function calcRiskScore(user, realizedSigma, corrPenalty = 1) {
  const lev = user.leverage ?? 1;
  const margin = user.margin ?? 0;
  return lev * realizedSigma * margin * corrPenalty;
}

function assignTiers(users, realizedSigma, corrMap) {
  const scored = users.map((u) => {
    // Two paths: explicit corrMap[id] override (for tests) OR hedgeChar-aware computation.
    const override = corrMap?.[u.id];
    const corrPenalty =
      typeof override === "number"
        ? override
        : calcHedgeCorrPenalty(u, users, corrMap);
    return { ...u, riskScore: calcRiskScore(u, realizedSigma, corrPenalty), corrPenalty };
  });
  const scores = scored.map((u) => u.riskScore).sort((a, b) => a - b);
  const lo = scores[Math.floor(scores.length * TIER_SPLIT.SAFE)] ?? 0;
  const hi = scores[Math.floor(scores.length * TIER_SPLIT.MEDIUM)] ?? 0;
  return scored.map((u) => ({
    ...u,
    tier: u.riskScore <= lo ? "SAFE" : u.riskScore <= hi ? "MEDIUM" : "RISKY",
  }));
}

// Long/short ratio beta — how far the book is tilted.
// Returns value in [0, 1] where 0.5 = perfectly balanced.
export function calcRatioBeta(longMargin, shortMargin) {
  const total = longMargin + shortMargin;
  if (total === 0) return 0.5;
  return longMargin / total;
}

// Safety-weight-adjusted share within a tier (§5.2).
// Distributes the aggregated P&L of a tier by each member's safety-inverse weight.
export function calcAdjShare(user, tieredUsers) {
  const wi = (user.margin ?? 0) * (1 / Math.max(1e-8, user.riskScore ?? 1));
  const denom = tieredUsers.reduce(
    (s, u) => s + (u.margin ?? 0) * (1 / Math.max(1e-8, u.riskScore ?? 1)),
    0
  );
  return denom > 0 ? wi / denom : 0;
}

// Settle one tier. Geometric P&L + barrier adjustment is computed per user,
// then the tier's aggregated P&L is redistributed by adjShare so safer members
// shoulder less of a losing tier and keep more of a winning one.
function settleTier(tieredUsers, priceOld, priceNew, sigma, stabilityFeePct) {
  let stabilityFeeCollected = 0;

  // First pass: per-user raw PnL + barrier margin.
  const raw = tieredUsers.map((u) => {
    if (!u.active || u.margin <= 0) return { ...u, pnl: 0, postBarrier: u.margin };

    const pnl = geometricPnl(u.margin, u.leverage ?? 1, priceOld, priceNew, u.side ?? "LONG");
    const { adjustedMargin } = deterministicBarrierAdjustment(
      priceOld, priceNew, sigma, u.leverage ?? 1, u.margin, u.side ?? "LONG"
    );
    const grossMargin = u.margin + pnl;
    const postBarrier = Math.min(grossMargin, adjustedMargin > 0 ? adjustedMargin : grossMargin);
    return { ...u, pnl, postBarrier };
  });

  // Tier-aggregated P&L (sum of individual pnl, net of barrier losses).
  const tierPnl = raw.reduce((s, u) => s + (u.postBarrier - u.margin), 0);

  // Redistribute via adjShare.
  const settled = raw.map((u) => {
    if (!u.active || u.margin <= 0) return u;

    const share = calcAdjShare(u, raw);
    const allocated = tierPnl * share;
    const newMarginPreFee = Math.max(0, u.margin + allocated);

    // Stability fee on RISKY only (§5.4 — routed to insurance pool).
    let fee = 0;
    if (u.tier === "RISKY") {
      fee = newMarginPreFee * stabilityFeePct;
      stabilityFeeCollected += fee;
    }

    const newMargin = Math.max(0, newMarginPreFee - fee);
    const liquidated = newMargin <= 0;

    return {
      ...u,
      margin: newMargin,
      pnl: allocated,
      liquidated,
      active: !liquidated,
      stabilityFee: fee,
      adjShare: share,
    };
  });

  return { settled, stabilityFeeCollected };
}

// Full pool settlement: tier → settle each tier (isolated) → collect fees.
// Tips are passed in pre-escrowed; they flow through without touching the pool.
export function settleDominantPool(
  users,
  priceOld,
  priceNew,
  realizedSigma,
  corrMap,
  stabilityFeePct = 0.002
) {
  const logs = [];
  const tiered = assignTiers(users, realizedSigma, corrMap);

  const safeTier = tiered.filter((u) => u.tier === "SAFE");
  const medTier = tiered.filter((u) => u.tier === "MEDIUM");
  const riskyTier = tiered.filter((u) => u.tier === "RISKY");

  const { settled: settledSafe, stabilityFeeCollected: feeS } = settleTier(
    safeTier, priceOld, priceNew, realizedSigma, 0
  );
  const { settled: settledMed, stabilityFeeCollected: feeM } = settleTier(
    medTier, priceOld, priceNew, realizedSigma, 0
  );
  const { settled: settledRisky, stabilityFeeCollected: feeR } = settleTier(
    riskyTier, priceOld, priceNew, realizedSigma, stabilityFeePct
  );

  const totalFee = feeS + feeM + feeR;
  const allSettled = [...settledSafe, ...settledMed, ...settledRisky];
  const liqCount = allSettled.filter((u) => u.liquidated).length;

  logs.push(
    `[POOL] SAFE=${settledSafe.length} MED=${settledMed.length} RISKY=${settledRisky.length} | liq=${liqCount} fee=$${totalFee.toFixed(2)}`
  );

  // Apply T-bill yield to remaining active margins (Floor 0 accrual).
  const final = allSettled.map((u) =>
    u.active ? { ...u, margin: u.margin * (1 + TBILL_RATE / 365) } : u
  );

  return {
    users: final,
    stabilityFeeCollected: totalFee,
    liquidationCount: liqCount,
    logs,
  };
}

// Escrow tips from matched auction fills BEFORE pool settlement (§5.2).
// Returns { tipEscrow, escrowLogs } — tipEscrow is a map
//   { [participantId]: { paid, received } } used by the caller to route
//   minority yield independently of cascade outcomes.
export function escrowTips(matched) {
  const escrow = {};
  const logs = [];

  const ensure = (id) => {
    if (!escrow[id]) escrow[id] = { paid: 0, received: 0 };
  };

  // Naming convention: dominant side pays tips; minority side receives.
  // Within each match, both long and short pay their tip (tipL, tipS); the
  // counterparty receives it (long's tip goes to short, vice versa).
  for (const m of matched) {
    const margin = m.margin ?? 0;
    const longPaid = margin * (m.longTip ?? 0);
    const shortPaid = margin * (m.shortTip ?? 0);

    if (m.longId) {
      ensure(m.longId);
      escrow[m.longId].paid += longPaid;
    }
    if (m.shortId) {
      ensure(m.shortId);
      escrow[m.shortId].paid += shortPaid;
    }
    // Tips cross to the counterparty (standard LAP minority-yield flow).
    if (m.shortId) {
      ensure(m.shortId);
      escrow[m.shortId].received += longPaid;
    }
    if (m.longId) {
      ensure(m.longId);
      escrow[m.longId].received += shortPaid;
    }
  }

  const totalPaid = Object.values(escrow).reduce((s, e) => s + e.paid, 0);
  const totalReceived = Object.values(escrow).reduce((s, e) => s + e.received, 0);
  if (matched.length > 0) {
    logs.push(
      `[TIP ESCROW] matched=${matched.length} paid=$${totalPaid.toFixed(2)} received=$${totalReceived.toFixed(2)}`
    );
  }

  return { tipEscrow: escrow, escrowLogs: logs };
}
