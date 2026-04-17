// Cross-market correlation matrix for the active pairs.
// Used by the credit system to penalise concentrated correlated books.

import { calcCorrelation } from "./math.js";
import { ACTIVE_PAIRS } from "../constants/assets.js";

// Build a correlation map from price histories.
// priceHistories: { [pairKey]: number[] }
// Returns { "PAIR_A:PAIR_B": rho }
export function calcCrossMarketCorrelations(priceHistories) {
  const keys = Object.keys(priceHistories).filter((k) => ACTIVE_PAIRS.includes(k));
  const corrMap = {};

  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const ka = keys[i];
      const kb = keys[j];
      const ha = priceHistories[ka] ?? [];
      const hb = priceHistories[kb] ?? [];
      const n = Math.min(ha.length, hb.length, 30);
      if (n < 3) continue;

      // Log-returns for correlation.
      const ra = ha.slice(-n - 1).slice(1).map((p, i2) => Math.log(p / ha[ha.length - n - 1 + i2]));
      const rb = hb.slice(-n - 1).slice(1).map((p, i2) => Math.log(p / hb[hb.length - n - 1 + i2]));
      const rho = calcCorrelation(ra, rb);
      corrMap[`${ka}:${kb}`] = rho;
      corrMap[`${kb}:${ka}`] = rho;
    }
  }

  return corrMap;
}

// Look up correlation between two pairs (symmetric).
export function getPairCorr(corrMap, pairA, pairB) {
  if (pairA === pairB) return 1;
  return corrMap?.[`${pairA}:${pairB}`] ?? corrMap?.[`${pairB}:${pairA}`] ?? 0;
}

// Portfolio correlation penalty: average pairwise correlation for a user's open positions.
// Returns a multiplier in [1, 2] — higher means more correlated → more penalised.
export function portfolioCorrelationPenalty(openPairs, corrMap) {
  if (!openPairs || openPairs.length < 2) return 1;
  let sumCorr = 0;
  let count = 0;
  for (let i = 0; i < openPairs.length; i++) {
    for (let j = i + 1; j < openPairs.length; j++) {
      sumCorr += Math.abs(getPairCorr(corrMap, openPairs[i], openPairs[j]));
      count++;
    }
  }
  const avgCorr = count > 0 ? sumCorr / count : 0;
  return 1 + avgCorr; // [1, 2]
}
