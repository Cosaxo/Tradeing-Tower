// LTV — "how much credit can you extract from your collateralised
// capital, given how diversified that capital is."
//
// Phase 5 rewrite: LTV now scores how the user has SPREAD their
// allocations across the new insurance markets, not how their LAP
// portfolio is composed. The previous portfolio-LTV is gone — the
// allocation system replaces "pool deposit" entirely, so the input
// shape changed.
//
// Five additive terms, same shape as before:
//
//   - concentration        : 1 − HHI on per-market stake share
//   - diversity            : Shannon entropy over the active markets
//   - breadth              : numMarkets vs total registry (rewards
//                             spreading across many distinct events)
//   minus
//   - maxWeight penalty    : if any single market > 50 % of stake
//
// `tail coverage` and `leverage discipline` — the old composition
// terms — don't apply to allocation-style collateral. They're
// absorbed by the breadth + diversity terms (allocating to GOLD-
// rally and tail-event markets contributes to breadth automatically).

import { allocationDiversificationStats } from "./allocations.js";

// Floor / ceiling — same band as before so downstream callers don't
// have to remap.
export const POOL_LTV_FLOOR = 0.30;
export const POOL_LTV_CEILING = 1.00;

// Term weights — sum to (CEILING − FLOOR) = 0.70 so a perfect
// allocation hits the ceiling.
export const POOL_LTV_W_CONCENTRATION = 0.25;
export const POOL_LTV_W_DIVERSITY = 0.25;
export const POOL_LTV_W_BREADTH = 0.20;
export const POOL_LTV_MAXWEIGHT_PENALTY = 0.20;

// Compute the LTV for a user's allocation across insurance markets.
//
// Inputs:
//   markets       — current insurance market list
//   userId
//   marketsTotal  — optional override for the registry size (used by
//                   the breadth term). Defaults to markets.length.
//
// Returns:
//   {
//     ltv,
//     breakdown: { floor, concentration, diversity, breadth, maxWeightPenalty },
//     stats: { numMarkets, hhi, maxWeight, shannonNorm, totalStake },
//   }
export function calcAllocationLtv({ markets = [], userId, marketsTotal = null }) {
  const stats = allocationDiversificationStats({ markets, userId });
  const total = marketsTotal ?? Math.max(1, markets.length);

  if (stats.totalStake <= 0) {
    return {
      ltv: POOL_LTV_FLOOR,
      breakdown: {
        floor: POOL_LTV_FLOOR,
        concentration: 0,
        diversity: 0,
        breadth: 0,
        maxWeightPenalty: 0,
      },
      stats,
    };
  }

  const concentration =
    POOL_LTV_W_CONCENTRATION * Math.max(0, Math.min(1, 1 - stats.hhi));
  const diversity =
    POOL_LTV_W_DIVERSITY * Math.max(0, Math.min(1, stats.shannonNorm));
  const breadthFraction = Math.min(1, stats.numMarkets / total);
  const breadth = POOL_LTV_W_BREADTH * breadthFraction;

  const overflow = Math.max(0, stats.maxWeight - 0.5) / 0.5;
  const maxWeightPenalty = POOL_LTV_MAXWEIGHT_PENALTY * overflow;

  const ltv = clamp(
    POOL_LTV_FLOOR + concentration + diversity + breadth - maxWeightPenalty,
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
      maxWeightPenalty: parseFloat(maxWeightPenalty.toFixed(4)),
    },
    stats: {
      numMarkets: stats.numMarkets,
      hhi: parseFloat(stats.hhi.toFixed(4)),
      maxWeight: parseFloat(stats.maxWeight.toFixed(4)),
      shannonNorm: parseFloat(stats.shannonNorm.toFixed(4)),
      totalStake: parseFloat(stats.totalStake.toFixed(2)),
    },
  };
}

// Available credit budget = totalStake × LTV − already-deployed.
export function calcAvailableCredit({
  markets,
  userId,
  deployedCredit = 0,
  marketsTotal = null,
}) {
  const { ltv, stats } = calcAllocationLtv({ markets, userId, marketsTotal });
  const budget = stats.totalStake * ltv;
  return Math.max(0, budget - deployedCredit);
}

// Whether the user is currently over budget.
export function isOverCreditBudget({ markets, userId, deployedCredit }) {
  const { ltv, stats } = calcAllocationLtv({ markets, userId });
  if (stats.totalStake <= 0) return deployedCredit > 0;
  return deployedCredit > stats.totalStake * ltv + 1e-6;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
