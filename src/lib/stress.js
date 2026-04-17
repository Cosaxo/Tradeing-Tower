// Stress testing and systemic solvency analysis.
//
// Computes per-pair liquidation thresholds, propagates a price shock across
// correlated pairs, and measures overall system solvency.

import { getPairCorr } from "./correlation.js";
import { deterministicBarrierAdjustment } from "./settlement.js";

// Liquidation threshold: price move that would wipe a position.
// Returns { pairKey, liqMove, liqPrice, leveragedLoss }.
export function calcStressThresholds(position, currentPrice) {
  const { leverage = 1, side = "LONG", margin = 0 } = position;
  if (leverage <= 0) return { liqMove: Infinity, liqPrice: 0, leveragedLoss: 0 };

  const liqMove = 1 / Math.max(0.1, leverage) * 0.9; // 90% of theoretical
  const liqPrice =
    side === "LONG"
      ? currentPrice * (1 - liqMove)
      : currentPrice * (1 + liqMove);

  const leveragedLoss = margin * leverage * liqMove;
  return { liqMove, liqPrice, leveragedLoss };
}

// Propagate a shock in one pair to correlated pairs.
// shockPct: fractional price change in the origin pair (negative = down move).
// Returns { [pairKey]: estimatedPricePct } for all affected pairs.
export function propagateShock(originPair, shockPct, corrMap, activePairs) {
  const impact = { [originPair]: shockPct };
  activePairs.forEach((pk) => {
    if (pk === originPair) return;
    const rho = getPairCorr(corrMap, originPair, pk);
    // Transmitted shock decays with correlation.
    impact[pk] = shockPct * rho * 0.7; // 70% transmission factor
  });
  return impact;
}

// Check each position against the shock scenario.
// Returns { survived, liquidated, systemLoss }.
export function applyShockToPositions(positions, shockImpact, prices, sigma) {
  let systemLoss = 0;
  const results = positions.map((pos) => {
    const priceDelta = shockImpact[pos.pairKey] ?? 0;
    const oldPrice = prices[pos.pairKey] ?? 1;
    const newPrice = oldPrice * (1 + priceDelta);

    const { probTouch, adjustedMargin } = deterministicBarrierAdjustment(
      oldPrice,
      newPrice,
      sigma,
      pos.leverage ?? 1,
      pos.margin ?? 0,
      pos.side ?? "LONG"
    );

    const liquidated = probTouch > 0.5;
    const loss = liquidated ? (pos.margin ?? 0) - adjustedMargin : 0;
    systemLoss += loss;

    return { ...pos, probTouch, adjustedMargin, liquidated, shockLoss: loss };
  });

  return {
    positions: results,
    survived: results.filter((p) => !p.liquidated).length,
    liquidated: results.filter((p) => p.liquidated).length,
    systemLoss,
  };
}

// System solvency: ratio of total remaining margin to total outstanding exposure.
// solvencyBuffer < 1 means the pool is under-collateralised.
export function calcSystemSolvencyBuffer(pairStates, insurancePoolDeposits) {
  let totalExposure = 0;
  let totalMargin = 0;

  Object.values(pairStates ?? {}).forEach((ps) => {
    if (!ps || !ps.users) return;
    ps.users.forEach((u) => {
      if (!u.active) return;
      totalExposure += (u.margin ?? 0) * (u.leverage ?? 1);
      totalMargin += u.margin ?? 0;
    });
  });

  const buffer = totalExposure > 0
    ? (totalMargin + (insurancePoolDeposits ?? 0)) / totalExposure
    : 1;

  return {
    solvencyBuffer: parseFloat(buffer.toFixed(4)),
    totalExposure,
    totalMargin,
    solvent: buffer >= 0.1,
  };
}
