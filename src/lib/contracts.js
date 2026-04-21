// LAP-native derivative contracts — whitepaper §7.1, §7.2.
//
// Imbalance contracts use reflection-principle pricing on log(ratio).
// Entropy contracts use mean-reverting OU expected multiplier over the
// contract window (λ = 0.15).

import { calcRatioBeta } from "./pool.js";
import { ENT_LAMBDA } from "../constants/system.js";

// ---------------------------------------------------------------------------
// Imbalance contracts (§7.1)
// ---------------------------------------------------------------------------

// Abramowitz & Stegun normal CDF approximation (deterministic, no Math.random).
function normalCdf(z) {
  const absZ = Math.abs(z);
  const phi = 1 / (1 + 0.2316419 * absZ);
  const poly =
    phi * (0.319381530 +
      phi * (-0.356563782 +
        phi * (1.781477937 +
          phi * (-1.821255978 +
            phi * 1.330274429))));
  const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
  return z < 0 ? poly * density : 1 - poly * density;
}

// Reflection-principle pricing (§7.1):
//
//   P(max ratio breaches threshold) ≈ 2 · Φ(−d / σ_ρ·√N)
//
// where d is log-distance to the threshold and σ_ρ is the std-dev of
// log(ratio) returns. Per-epoch premium = P(breach) / N.
export function calcImbalancePremium(
  longMargin,
  shortMargin,
  options = {}
) {
  const {
    strikeImbalance = 0.3,
    windowN = 10,
    sigmaRho = 0.2,
    baseRate = 0.005,
  } = options;

  const beta = calcRatioBeta(longMargin, shortMargin);
  const imbalance = Math.abs(beta - 0.5) * 2;

  // Current log-ratio (0 = balanced, +log(2) = 2:1 long-heavy).
  const ratio = Math.max(0.01, (shortMargin > 0 ? longMargin / shortMargin : 10));
  const logRatio = Math.log(ratio);

  // Threshold expressed as log-distance. strikeImbalance is the fractional
  // imbalance (0..1); convert to log-ratio space.
  const breachRatio = (1 + strikeImbalance) / Math.max(0.01, 1 - strikeImbalance);
  const logBreach = Math.log(breachRatio);
  const d = Math.max(0, logBreach - Math.abs(logRatio));

  const probBreach = Math.min(1, 2 * normalCdf(-d / Math.max(0.01, sigmaRho * Math.sqrt(windowN))));

  // Convert to per-epoch premium and blend with a small base so contracts
  // priced near-neutral don't have premiums of zero.
  const perEpochPremium = probBreach / Math.max(1, windowN);
  return Math.max(baseRate * 0.1, baseRate + perEpochPremium * (1 + imbalance * 2));
}

// Settle imbalance contracts each epoch.
export function settleImbalanceContracts(contracts, longMargin, shortMargin) {
  const beta = calcRatioBeta(longMargin, shortMargin);
  const imbalance = Math.abs(beta - 0.5) * 2;
  const logs = [];
  let netPayout = 0;

  const settled = contracts.map((c) => {
    const triggered = imbalance > c.strikeImbalance;
    const directionMatch =
      (c.direction === "LONG" && beta > 0.5) || (c.direction === "SHORT" && beta < 0.5);

    if (!triggered || !directionMatch) {
      return { ...c, payout: 0, expired: false };
    }

    const excess = imbalance - c.strikeImbalance;
    const payout = c.size * excess * 2;
    netPayout += payout;
    logs.push(
      `[IMBAL CONTRACT] ${c.id} dir=${c.direction} | imbalance=${imbalance.toFixed(3)} > strike=${c.strikeImbalance.toFixed(3)} | payout=$${payout.toFixed(2)}`
    );
    return { ...c, payout, expired: true };
  });

  return { settled, netPayout, logs };
}

// ---------------------------------------------------------------------------
// Entropy contracts (§7.2)
// ---------------------------------------------------------------------------

// Mean-reverting expected multiplier over N epochs:
//
//   m_exp(t) = 1 + (m_0 − 1) · e^{−λt}
//   m̄ = (1/N) Σ m_exp(t)
//
// Premium is positive when the locked multiplier is above expected mean
// (provider pays to lock in), negative-direction when below.
export function calcExpectedMultiplier(lockedMult, windowN = 10, lambda = ENT_LAMBDA) {
  if (windowN <= 0) return lockedMult;
  let sum = 0;
  for (let t = 1; t <= windowN; t++) {
    sum += 1 + (lockedMult - 1) * Math.exp(-lambda * t);
  }
  return sum / windowN;
}

export function calcEntropyContractPremium(
  normWeights,
  lockedMult,
  options = {}
) {
  const { baseRate = 0.008, windowN = 10, lambda = ENT_LAMBDA } = options;

  const mean =
    normWeights && normWeights.length > 0
      ? normWeights.reduce((s, w) => s + w, 0) / normWeights.length
      : 1;
  const variance =
    normWeights && normWeights.length > 0
      ? normWeights.reduce((s, w) => s + (w - mean) ** 2, 0) / normWeights.length
      : 0;
  const spreadFactor = 1 + Math.sqrt(variance) * 10;

  // If locked above OU-expected mean, pay to lock; below, receive.
  const expectedMean = calcExpectedMultiplier(lockedMult, windowN, lambda);
  const lockPremium = Math.max(0, lockedMult - expectedMean);

  return baseRate * spreadFactor * (1 + lockPremium * 3);
}

export function settleEntropyContracts(contracts, currentNormWeights, avgEntropyMult) {
  const logs = [];
  let netPayout = 0;

  const settled = contracts.map((c) => {
    const gain = Math.max(0, avgEntropyMult - c.lockedMult);
    const payout = c.size * gain;
    netPayout += payout;
    if (payout > 0) {
      logs.push(
        `[ENT CONTRACT] ${c.id} locked=${c.lockedMult.toFixed(3)} current=${avgEntropyMult.toFixed(3)} | payout=$${payout.toFixed(2)}`
      );
    }
    return { ...c, payout, expired: true };
  });

  void currentNormWeights; // reserved for future delta hedging
  return { settled, netPayout, logs };
}
