// Yield router: surfaces actionable suggestions to the player based on current
// market conditions, entropy weights, regime, and their own portfolio.

import { getEffectiveCap } from "./esma.js";

// Score each active pair for yield attractiveness and return ranked suggestions.
//
// pairStates: { [pairKey]: { normWeights, avgEntropyMult, regime, realizedSigma, currentYield, auctionResult } }
// playerPositions: array of { pairKey, side, leverage, margin }
// Returns array of { pairKey, action, score, reason } sorted by score desc.
export function calcYieldRouterSuggestions(pairStates, playerPositions, creditScore = 0) {
  const suggestions = [];
  const openPairs = new Set((playerPositions ?? []).map((p) => p.pairKey));

  Object.entries(pairStates ?? {}).forEach(([pairKey, state]) => {
    if (!state) return;

    const {
      normWeights = [],
      avgEntropyMult = 1,
      regime = null,
      realizedSigma = 0.02,
      currentYield = 0,
    } = state;

    const { effectiveCap } = getEffectiveCap(pairKey, realizedSigma);

    // Base attractiveness: current yield relative to T-bill, weighted by entropy.
    const yieldSpread = Math.max(0, currentYield - 0.001);
    let score = yieldSpread * avgEntropyMult * 10;

    // Regime bonuses.
    if (regime?.key === "CALM") score *= 1.2;
    if (regime?.key === "TRENDING_UP") score *= 1.1;
    if (regime?.key === "CRASH" || regime?.key === "HIGH_VOL") score *= 0.5;

    // Entropy premium: look for buckets with the highest weight (thin = high yield).
    const maxWeight = normWeights.length > 0 ? Math.max(...normWeights) : 1;
    score += maxWeight * 2;

    // Already open → bonus for adding size if score is high.
    const alreadyOpen = openPairs.has(pairKey);
    if (alreadyOpen) score *= 0.8; // mild diversification nudge away

    // Credit bonus for top performers.
    score *= 1 + creditScore * 0.5;

    let action = "OPEN_LONG";
    let reason = `Yield=${(currentYield * 100).toFixed(2)}% EntropyMult=${avgEntropyMult.toFixed(2)}x`;

    if (regime?.key === "CRASH") {
      action = "REDUCE";
      reason = `Crash regime: reduce exposure on ${pairKey}`;
    } else if (regime?.key === "TRENDING_DN") {
      action = "OPEN_SHORT";
      reason = `Downtrend on ${pairKey}`;
    } else if (avgEntropyMult > 1.5 && !alreadyOpen) {
      action = "OPEN_LONG";
      reason = `High entropy premium ${avgEntropyMult.toFixed(2)}x on ${pairKey}`;
    } else if (effectiveCap < 2 && alreadyOpen) {
      action = "REDUCE";
      reason = `Low ESMA cap ${effectiveCap.toFixed(1)}x — reduce risk`;
    }

    suggestions.push({ pairKey, action, score: parseFloat(score.toFixed(4)), reason });
  });

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 6);
}
