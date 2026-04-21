// Insurance pool. Replaces the earlier flat `insuranceFund` scalar.
//
// The pool's yield is driven by the KL divergence between actual and ideal
// leverage fills across the whole market: stressed markets pay depositors
// more, which keeps capital locked during crises instead of fleeing.

import { ACTIVE_PAIRS } from "../constants/assets.js";
import {
  INSURANCE_K,
  INSURANCE_PREMIUM_RATE,
  POOL_DEPTH_MAX,
  POOL_MAX_CLAIM_RATIO,
  POOL_LOCKUP_EPOCHS,
} from "../constants/system.js";
import { timeWeightedYieldMult } from "./math.js";

export const INSURANCE_POOL_CONSTANTS = { INSURANCE_K, INSURANCE_PREMIUM_RATE, POOL_LOCKUP_EPOCHS };

export function calcInsurancePremium(exposure, realizedSigma) {
  const volMultiplier = Math.min(5, realizedSigma / 0.01);
  return exposure * INSURANCE_PREMIUM_RATE * volMultiplier;
}

export function initInsurancePool() {
  return {
    deposits: {}, // { userId: { amount, depositEpoch, lockupRemaining } }
    totalDeposits: 0,
    pendingPremiums: 0,
    pendingStabilityFee: 0,
    pendingClaims: 0,
    claimsHistory: [],
    lastYieldPct: 0,
    auctionDepthScore: 0,
    yieldMultiplier: 1.0,
    cumulativeYield: 0,
    mediumEpochCount: 0,
  };
}

// KL divergence between actual and ideal auction fills - proxies market stress.
export function calcAuctionDepthScore(auctionResult) {
  if (!auctionResult) return 0;
  const curve =
    auctionResult.dominantSide === "LONG" ? auctionResult.longCurve : auctionResult.shortCurve;
  if (!curve || curve.length === 0) return 1.0;
  const filled = curve.filter((b) => b.ideal > 0);
  if (filled.length === 0) return 1.0;
  const totalIdeal = filled.reduce((s, b) => s + b.ideal, 0);
  const totalActual = filled.reduce((s, b) => s + b.actual, 0);
  if (totalActual === 0) return 1.0;
  let kl = 0;
  filled.forEach((b) => {
    const p = b.ideal / totalIdeal;
    const q = Math.max(0.001, b.actual) / totalActual;
    if (p > 0.001) kl += p * Math.log(p / q);
  });
  return Math.min(1.0, kl / POOL_DEPTH_MAX);
}

// Sigmoid from 1x (calm) to 3x (crisis). Steep around the 0.4 threshold.
export function depthToYieldMultiplier(depthScore) {
  return 1.0 + 2.0 / (1.0 + Math.exp(-8 * (depthScore - 0.4)));
}

export function settleInsurancePool(pool, allPairAuctions, epochIndex) {
  const log = [];
  const next = {
    ...pool,
    deposits: Object.fromEntries(
      Object.entries(pool.deposits).map(([uid, d]) => [uid, { ...d }])
    ),
    claimsHistory: [...pool.claimsHistory],
  };

  // Step 1: average auction depth across all pairs
  let avgDepth = 0;
  let pairCount = 0;
  Object.values(allPairAuctions).forEach((auction) => {
    if (!auction) return;
    avgDepth += calcAuctionDepthScore(auction);
    pairCount += 1;
  });
  avgDepth = pairCount > 0 ? avgDepth / pairCount : 0;
  next.auctionDepthScore = avgDepth;
  next.yieldMultiplier = depthToYieldMultiplier(avgDepth);

  // Step 2: multiplier-adjusted revenue
  const rawRevenue = next.pendingPremiums + next.pendingStabilityFee;
  const adjustedRevenue = rawRevenue * next.yieldMultiplier;

  // Step 3: pay claims (capped at 50% of deposits)
  const claimsPaid = Math.min(next.pendingClaims, next.totalDeposits * POOL_MAX_CLAIM_RATIO);
  const unmetClaims = next.pendingClaims - claimsPaid;
  if (claimsPaid > 0) {
    next.claimsHistory.push({ epoch: epochIndex, amount: claimsPaid, unmet: unmetClaims });
    log.push(`[POOL CLAIM] $${claimsPaid.toFixed(2)} paid. Unmet: $${unmetClaims.toFixed(2)}`);
  }

  // Step 4: net to distribute
  const netDistrib = adjustedRevenue - claimsPaid;

  // Step 5: distribute to depositors by share x loyalty
  if (next.totalDeposits > 0) {
    Object.entries(next.deposits).forEach(([, dep]) => {
      const share = dep.amount / next.totalDeposits;
      const loyaltyMult = timeWeightedYieldMult(epochIndex - (dep.depositEpoch ?? epochIndex));
      const payout = netDistrib * share * loyaltyMult;
      dep.amount = Math.max(0, dep.amount + payout);
      if (dep.lockupRemaining > 0) dep.lockupRemaining -= 1;
    });
    next.totalDeposits = Object.values(next.deposits).reduce((s, d) => s + d.amount, 0);
  }

  const yieldPct = next.totalDeposits > 0 ? (netDistrib / next.totalDeposits) * 100 : 0;
  next.lastYieldPct = yieldPct;
  next.cumulativeYield = (next.cumulativeYield ?? 0) + Math.max(0, netDistrib);

  log.push(
    `[POOL SLOW] Depth=${avgDepth.toFixed(3)} Mult=${next.yieldMultiplier.toFixed(2)}x Yield=${yieldPct.toFixed(4)}% Net=$${netDistrib.toFixed(2)}`
  );

  next.pendingPremiums = 0;
  next.pendingStabilityFee = 0;
  next.pendingClaims = Math.max(0, unmetClaims);

  return {
    pool: next,
    log,
    flow: {
      rawRevenue,
      adjustedRevenue,
      claimsPaid,
      unmetClaims,
      netDistrib,
      yieldMultiplier: next.yieldMultiplier,
    },
  };
}

export { ACTIVE_PAIRS }; // re-export for tests
