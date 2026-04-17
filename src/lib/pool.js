// Dominant-pool settlement with risk-weighted cascade tiers.
//
// Positions are bucketed into SAFE / MEDIUM / RISKY by riskScore, then each
// tier settles independently. The stability fee is charged per RISKY position.

import { geometricPnl, deterministicBarrierAdjustment } from "./settlement.js";
import { TBILL_RATE } from "../constants/system.js";

// Risk score: higher = more dangerous to the pool.
export function calcRiskScore(user, realizedSigma, corrPenalty = 1) {
  const lev = user.leverage ?? 1;
  const margin = user.margin ?? 0;
  return lev * realizedSigma * margin * corrPenalty;
}

// Thresholds for tier assignment.
const RISK_THRESHOLDS = { SAFE: 0.33, MEDIUM: 0.66 }; // quantile breakpoints

function assignTiers(users, realizedSigma, corrMap) {
  const scored = users.map((u) => {
    const corrPenalty = corrMap?.[u.id] ?? 1;
    return { ...u, riskScore: calcRiskScore(u, realizedSigma, corrPenalty) };
  });
  const scores = scored.map((u) => u.riskScore).sort((a, b) => a - b);
  const lo = scores[Math.floor(scores.length * RISK_THRESHOLDS.SAFE)] ?? 0;
  const hi = scores[Math.floor(scores.length * RISK_THRESHOLDS.MEDIUM)] ?? 0;
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

// Settle one tier: apply geometric P&L + barrier adjustment.
// Returns updated users and a premium collected for the insurance pool.
function settleTier(tieredUsers, priceOld, priceNew, sigma, stabilityFeePct) {
  let stabilityFeeCollected = 0;
  const settled = tieredUsers.map((u) => {
    if (!u.active || u.margin <= 0) return u;

    const pnl = geometricPnl(u.margin, u.leverage ?? 1, priceOld, priceNew, u.side ?? "LONG");

    const { adjustedMargin } = deterministicBarrierAdjustment(
      priceOld,
      priceNew,
      sigma,
      u.leverage ?? 1,
      u.margin,
      u.side ?? "LONG"
    );

    const grossMargin = u.margin + pnl;
    const postBarrier = Math.min(grossMargin, adjustedMargin > 0 ? adjustedMargin : grossMargin);

    // Stability fee on RISKY positions only.
    let fee = 0;
    if (u.tier === "RISKY") {
      fee = Math.max(0, postBarrier) * stabilityFeePct;
      stabilityFeeCollected += fee;
    }

    const newMargin = Math.max(0, postBarrier - fee);
    const liquidated = newMargin <= 0;

    return {
      ...u,
      margin: newMargin,
      pnl,
      liquidated,
      active: !liquidated,
      stabilityFee: fee,
    };
  });
  return { settled, stabilityFeeCollected };
}

// Full pool settlement: tier → settle each tier → collect stability fees.
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
  const liqCount = [...settledSafe, ...settledMed, ...settledRisky].filter((u) => u.liquidated).length;

  logs.push(
    `[POOL] SAFE=${settledSafe.length} MED=${settledMed.length} RISKY=${settledRisky.length} | liq=${liqCount} fee=$${totalFee.toFixed(2)}`
  );

  // Apply T-bill yield to remaining active margins.
  const allSettled = [...settledSafe, ...settledMed, ...settledRisky].map((u) =>
    u.active ? { ...u, margin: u.margin * (1 + TBILL_RATE / 365) } : u
  );

  return {
    users: allSettled,
    stabilityFeeCollected: totalFee,
    liquidationCount: liqCount,
    logs,
  };
}
