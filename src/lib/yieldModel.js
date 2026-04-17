// Market-implied yield model.
//
// The equilibrium yield level and mean-reversion speed are estimated from
// observed yield history via EMA and lag-1 autocorrelation. No hardcoded
// equilibrium.

import {
  YIELD_BUFFER_MIN_RATE,
  YIELD_BUFFER_MAX_RATE,
  YIELD_BUFFER_THRESHOLD,
} from "../constants/system.js";

export function updateYieldModel(prev, currentYield) {
  const alpha = 0.05;
  const yieldEq = prev.yieldEq * (1 - alpha) + currentYield * alpha;
  const yieldChange = currentYield - prev.prevYield;
  const newAcov = prev.acov * 0.95 + yieldChange * prev.prevChange * 0.05;
  const newVar = prev.yieldVar * 0.95 + yieldChange * yieldChange * 0.05;
  const rho1 = newVar > 0 ? Math.max(-0.99, Math.min(0.99, newAcov / newVar)) : 0;
  const kappa = Math.max(
    0.01,
    Math.min(0.5, -Math.log(Math.max(0.01, 1 - Math.abs(rho1))))
  );
  return {
    yieldEq,
    kappa,
    prevYield: currentYield,
    prevChange: yieldChange,
    acov: newAcov,
    yieldVar: newVar,
  };
}

// Present value of a yield strip: Ornstein-Uhlenbeck mean-reverting yield
// discounted at T-bill rate.
export function calcYieldStripValue(baseYieldPct, exposure, epochs, discountRate, yieldModel) {
  const yieldEq = yieldModel?.yieldEq ?? baseYieldPct;
  const kappa = yieldModel?.kappa ?? 0.1;
  let pv = 0;
  for (let t = 1; t <= epochs; t++) {
    const expectedYield = yieldEq + (baseYieldPct - yieldEq) * Math.exp(-kappa * t);
    pv += ((expectedYield / 100) * exposure) / Math.pow(1 + (discountRate ?? 0.001), t);
  }
  return pv;
}

// Inflate vol for strip pricing using recent jump activity.
export function jumpAdjustedSigma(realizedSigma, returnHistory) {
  if (!returnHistory || returnHistory.length < 10) return realizedSigma;
  const jumps = returnHistory.filter((r) => Math.abs(r) > 3 * realizedSigma);
  const jumpIntensity = jumps.length / returnHistory.length;
  const avgJumpExcess =
    jumpIntensity > 0
      ? jumps.reduce((s, r) => s + (Math.abs(r) - 3 * realizedSigma), 0) / jumps.length
      : 0;
  return realizedSigma * (1 + jumpIntensity * 2) + avgJumpExcess;
}

// Strip premium using an Abramowitz & Stegun approximation to the normal CDF
// (deterministic, no randomness).
export function calcStripPremium(leverage, realizedSigma, threshold, protectedFraction, returnHistory) {
  const adjSigma = jumpAdjustedSigma(realizedSigma, returnHistory);
  const lossLogReturn = Math.log(Math.max(0.001, 1 - threshold)) / Math.max(0.1, leverage);
  const z = lossLogReturn / Math.max(0.001, adjSigma);
  const absZ = Math.abs(z);
  const phi = 1 / (1 + 0.2316419 * absZ);
  const polyApprox =
    phi *
    (0.319381530 +
      phi *
        (-0.356563782 +
          phi * (1.781477937 + phi * (-1.821255978 + phi * 1.330274429))));
  const normalCDF =
    z < 0
      ? (polyApprox * Math.exp((-z * z) / 2)) / Math.sqrt(2 * Math.PI)
      : 1 - (polyApprox * Math.exp((-z * z) / 2)) / Math.sqrt(2 * Math.PI);
  const probLoss = Math.max(0, Math.min(1, normalCDF));
  const expectedShortfall =
    (adjSigma * leverage * Math.exp((-z * z) / 2)) /
    Math.sqrt(2 * Math.PI) /
    Math.max(0.001, probLoss);
  const rawPremium = probLoss * Math.min(expectedShortfall, threshold * 2) * protectedFraction;
  return Math.max(0.0001, Math.min(0.08, rawPremium));
}

// Dynamic buffer rate: the buffer contribution scales with buffer health and
// rewards loyal providers.
export function dynamicBufferRate(yieldBuffer, epochsHeld) {
  const TARGET_BUFFER = 5000;
  const bufferHealth = Math.min(1, yieldBuffer / TARGET_BUFFER);
  const baseRate =
    YIELD_BUFFER_MAX_RATE - (YIELD_BUFFER_MAX_RATE - YIELD_BUFFER_MIN_RATE) * bufferHealth;
  const loyaltyDiscount = Math.min(0.6, (epochsHeld / 20) * 0.6);
  return baseRate * (1 - loyaltyDiscount);
}

export function calcYieldBufferContribution(yieldEst, epochsHeld, yieldBuffer) {
  const rate = dynamicBufferRate(yieldBuffer, epochsHeld);
  const excess = Math.max(0, yieldEst - YIELD_BUFFER_THRESHOLD);
  return excess * rate;
}
