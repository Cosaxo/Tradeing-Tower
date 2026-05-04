// LTV — "how much credit can you extract from your collateralised
// capital, given how diversified that capital is, how much
// reinsurance covers it, and how independent the underlying events
// are."
//
// Sprint 2 rewrite. The vision is: LTV → 1.0 only when reinsurance
// covers enough of each position AND the positions are independent
// enough. Pure diversification alone caps you below 1.0 — you have
// to actually buy the hedge and choose uncorrelated exposures.
//
// Six additive terms:
//
//   - concentration        : 1 − HHI on per-market stake share
//   - diversity            : Shannon entropy over the active markets
//   - breadth              : numMarkets vs target (rewards spreading)
//   - reinsuranceCoverage  : Σ (face_i × coverageFraction_i) / totalInsurerExposure
//   - independence         : 1 − weighted-avg pairwise correlation
//                            between the user's allocations
//   minus
//   - maxWeight penalty    : if any single market > 50 % of stake
//
// Term weights sum to (CEILING − FLOOR) = 0.70 so a perfect setup
// hits the ceiling.

import { allocationDiversificationStats } from "./allocations.js";
import { getPairCorr } from "./correlation.js";

// Floor / ceiling.
export const POOL_LTV_FLOOR = 0.30;
export const POOL_LTV_CEILING = 1.00;

// Term weights (sum 0.70). Reinsurance dominates because it's the
// strongest evidence the insurer-side exposure is hedged. Independence
// is the second strongest because correlated allocations defeat the
// diversification claim. Diversification metrics (concentration,
// diversity, breadth) round it out.
export const POOL_LTV_W_CONCENTRATION = 0.10;
export const POOL_LTV_W_DIVERSITY = 0.10;
export const POOL_LTV_W_BREADTH = 0.10;
export const POOL_LTV_W_REINSURANCE = 0.25;
export const POOL_LTV_W_INDEPENDENCE = 0.15;
export const POOL_LTV_MAXWEIGHT_PENALTY = 0.20;

// Cardinality-stable breadth target — adding new event markets to the
// registry no longer silently lowers everyone's LTV. Tunable as policy.
export const POOL_LTV_BREADTH_TARGET = 8;

// ---------------------------------------------------------------------------
// Reinsurance coverage ratio
// ---------------------------------------------------------------------------

// What fraction of the user's insurer-side exposure is covered by
// reinsurance they've bought as a buyer? Each reinsurance product
// pays back coverageFraction × insurance_loss when the user takes a
// claim, so the effective covered notional is face × coverageFraction
// summed across products. Capped at 1.
export function calcReinsuranceCoverageRatio({ totalInsurerExposure, reinsurance, userId }) {
  if (totalInsurerExposure <= 1e-9) return 0;
  const totalCovered = (reinsurance ?? []).reduce(
    (s, p) => s + (p.buyerCoverage?.[userId] ?? 0) * (p.coverageFraction ?? 0),
    0
  );
  return Math.max(0, Math.min(1, totalCovered / totalInsurerExposure));
}

// ---------------------------------------------------------------------------
// Independence score
// ---------------------------------------------------------------------------

// 1 − weighted average pairwise |correlation| between the user's
// allocated event markets. Independence is high when allocations span
// uncorrelated underlyings (e.g. BTC events + GOLD events + macro
// events). It collapses when allocations bunch up under the same
// pair-key.
//
// Heuristic correlation:
//   - Same pairKey on both sides            → ρ = 1   (perfectly correlated)
//   - Different pairKey, both per-pair      → ρ = |corrMap[a, b]|
//   - Either side is macro (pairKey null)   → ρ = 0.5 (moderate prior)
//
// Returns a value in [0, 1]; 1 = fully independent.
export function calcAllocationIndependence({ markets, userId, correlationMap = {} }) {
  const userMarkets = (markets ?? []).filter(
    (m) => (m.insurerPositions?.[userId] ?? 0) > 0
  );
  if (userMarkets.length === 0) return 0;
  if (userMarkets.length === 1) return 1; // a single allocation is "as independent as it gets"

  const totalStake = userMarkets.reduce(
    (s, m) => s + (m.insurerPositions?.[userId] ?? 0),
    0
  );
  if (totalStake <= 0) return 0;

  // Normalise weights.
  const weighted = userMarkets.map((m) => ({
    pairKey: m.pairKey ?? null,
    w: (m.insurerPositions?.[userId] ?? 0) / totalStake,
  }));

  // Weighted average pairwise correlation across the upper triangle.
  let sumW = 0;
  let sumWC = 0;
  for (let i = 0; i < weighted.length; i++) {
    for (let j = i + 1; j < weighted.length; j++) {
      const a = weighted[i];
      const b = weighted[j];
      const w = a.w * b.w;
      let rho;
      if (a.pairKey != null && b.pairKey != null && a.pairKey === b.pairKey) {
        rho = 1;
      } else if (a.pairKey == null || b.pairKey == null) {
        rho = 0.5;
      } else {
        rho = Math.abs(getPairCorr(correlationMap ?? {}, a.pairKey, b.pairKey));
      }
      sumWC += w * rho;
      sumW += w;
    }
  }

  const avgCorr = sumW > 0 ? sumWC / sumW : 0;
  return Math.max(0, Math.min(1, 1 - avgCorr));
}

// ---------------------------------------------------------------------------
// LTV
// ---------------------------------------------------------------------------

// Compute the LTV for a user's allocation. Inputs:
//
//   markets        — current insurance market list
//   userId
//   reinsurance    — reinsurance product list (default [])
//                    Each product carries `coverage[userId]` (faces bought
//                    as a buyer) and `coverageFraction`. Together with
//                    the user's totalInsurerExposure they yield the
//                    coverage ratio.
//   correlationMap — cross-pair correlation matrix (default {})
//                    Drives the independence score.
//   marketsTotal   — DEPRECATED. Kept for backwards compatibility but
//                    ignored — breadth divisor is the immutable
//                    POOL_LTV_BREADTH_TARGET.
export function calcAllocationLtv({
  markets = [],
  userId,
  reinsurance = [],
  correlationMap = {},
  marketsTotal: _marketsTotal = null,
}) {
  const stats = allocationDiversificationStats({ markets, userId });

  if (stats.totalStake <= 0) {
    return {
      ltv: POOL_LTV_FLOOR,
      breakdown: {
        floor: POOL_LTV_FLOOR,
        concentration: 0,
        diversity: 0,
        breadth: 0,
        reinsuranceCoverage: 0,
        independence: 0,
        maxWeightPenalty: 0,
      },
      stats: {
        ...stats,
        coverageRatio: 0,
        independenceScore: 0,
      },
    };
  }

  const concentration =
    POOL_LTV_W_CONCENTRATION * Math.max(0, Math.min(1, 1 - stats.hhi));
  const diversity =
    POOL_LTV_W_DIVERSITY * Math.max(0, Math.min(1, stats.shannonNorm));
  const breadthFraction = Math.min(1, stats.numMarkets / POOL_LTV_BREADTH_TARGET);
  const breadth = POOL_LTV_W_BREADTH * breadthFraction;

  const coverageRatio = calcReinsuranceCoverageRatio({
    totalInsurerExposure: stats.totalStake,
    reinsurance,
    userId,
  });
  const reinsuranceCoverage = POOL_LTV_W_REINSURANCE * coverageRatio;

  const independenceScore = calcAllocationIndependence({
    markets,
    userId,
    correlationMap,
  });
  const independence = POOL_LTV_W_INDEPENDENCE * independenceScore;

  const overflow = Math.max(0, stats.maxWeight - 0.5) / 0.5;
  const maxWeightPenalty = POOL_LTV_MAXWEIGHT_PENALTY * overflow;

  const ltv = clamp(
    POOL_LTV_FLOOR +
      concentration +
      diversity +
      breadth +
      reinsuranceCoverage +
      independence -
      maxWeightPenalty,
    POOL_LTV_FLOOR,
    POOL_LTV_CEILING
  );

  return {
    ltv: parseFloat(ltv.toFixed(4)),
    breakdown: {
      floor: POOL_LTV_FLOOR,
      concentration: parseFloat(concentration.toFixed(4)),
      diversity: parseFloat(diversity.toFixed(4)),
      breadth: parseFloat(breadth.toFixed(4)),
      reinsuranceCoverage: parseFloat(reinsuranceCoverage.toFixed(4)),
      independence: parseFloat(independence.toFixed(4)),
      maxWeightPenalty: parseFloat(maxWeightPenalty.toFixed(4)),
    },
    stats: {
      numMarkets: stats.numMarkets,
      hhi: parseFloat(stats.hhi.toFixed(4)),
      maxWeight: parseFloat(stats.maxWeight.toFixed(4)),
      shannonNorm: parseFloat(stats.shannonNorm.toFixed(4)),
      totalStake: parseFloat(stats.totalStake.toFixed(2)),
      coverageRatio: parseFloat(coverageRatio.toFixed(4)),
      independenceScore: parseFloat(independenceScore.toFixed(4)),
    },
  };
}

// Available credit budget = totalStake × LTV − already-deployed.
export function calcAvailableCredit({
  markets,
  userId,
  reinsurance = [],
  correlationMap = {},
  deployedCredit = 0,
  marketsTotal = null,
}) {
  const { ltv, stats } = calcAllocationLtv({
    markets,
    userId,
    reinsurance,
    correlationMap,
    marketsTotal,
  });
  const budget = stats.totalStake * ltv;
  return Math.max(0, budget - deployedCredit);
}

// Whether the user is currently over budget.
export function isOverCreditBudget({
  markets,
  userId,
  reinsurance = [],
  correlationMap = {},
  deployedCredit,
}) {
  const { ltv, stats } = calcAllocationLtv({
    markets,
    userId,
    reinsurance,
    correlationMap,
  });
  if (stats.totalStake <= 0) return deployedCredit > 0;
  return deployedCredit > stats.totalStake * ltv + 1e-6;
}

// ---------------------------------------------------------------------------
// Tier-3 hard gate
// ---------------------------------------------------------------------------

// Tier 2 → 3 gate: to open an active LAP, the user must have:
//   - allocated to ≥ MIN_TIER3_MARKETS distinct insurance markets
//   - no single market holding > MAX_TIER3_SINGLE_WEIGHT of total stake
//   - bought at least some reinsurance coverage
//
// Returns { open, missing[] }. Pure — no side effects.
export const MIN_TIER3_MARKETS = 3;
export const MAX_TIER3_SINGLE_WEIGHT = 0.5;

export function evaluateTier3Gate({ markets, reinsurance = [], userId }) {
  const stats = allocationDiversificationStats({ markets, userId });
  const missing = [];

  if (stats.numMarkets < MIN_TIER3_MARKETS) {
    missing.push(
      `allocate to ≥${MIN_TIER3_MARKETS} markets (have ${stats.numMarkets})`
    );
  }
  if (stats.maxWeight > MAX_TIER3_SINGLE_WEIGHT + 1e-6) {
    missing.push(
      `no single market > ${(MAX_TIER3_SINGLE_WEIGHT * 100).toFixed(0)}% (max is ${(stats.maxWeight * 100).toFixed(0)}%)`
    );
  }

  const totalReinsuranceFace = (reinsurance ?? []).reduce(
    (s, p) => s + (p.buyerCoverage?.[userId] ?? 0),
    0
  );
  if (totalReinsuranceFace <= 0) {
    missing.push("buy reinsurance coverage");
  }

  return {
    open: missing.length === 0,
    missing,
    stats: { ...stats, totalReinsuranceFace },
  };
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
