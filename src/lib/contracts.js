// LAP-native derivative contracts: Imbalance contracts and Entropy contracts.
//
// Imbalance contracts pay when the long/short ratio moves away from neutral.
// Entropy contracts lock in a yield multiplier from the current auction entropy.

import { calcRatioBeta } from "./pool.js";

// ---------------------------------------------------------------------------
// Imbalance contracts
// ---------------------------------------------------------------------------

// Premium scales with how far the book is already tilted.
// A buyer pays this to receive a payout if imbalance *increases*.
export function calcImbalancePremium(longMargin, shortMargin, baseRate = 0.005) {
  const beta = calcRatioBeta(longMargin, shortMargin);
  const imbalance = Math.abs(beta - 0.5) * 2; // [0,1]
  return baseRate * (1 + imbalance * 3);
}

// Settle all imbalance contracts for the current epoch.
// Each contract holds {id, direction, size, strikeImbalance, premium}.
// Payout when the realised imbalance exceeds the strike in the contract direction.
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
// Entropy contracts
// ---------------------------------------------------------------------------

// Premium for locking in the current entropy multiplier.
// Higher entropy spread (wider normWeights variance) → more expensive.
export function calcEntropyContractPremium(normWeights, lockedMult, baseRate = 0.008) {
  if (!normWeights || normWeights.length === 0) return baseRate;
  const mean = normWeights.reduce((s, w) => s + w, 0) / normWeights.length;
  const variance =
    normWeights.reduce((s, w) => s + (w - mean) ** 2, 0) / normWeights.length;
  const spreadFactor = 1 + Math.sqrt(variance) * 10;
  const lockBias = Math.max(1, lockedMult) - 1; // higher locked mult = pricier
  return baseRate * spreadFactor * (1 + lockBias);
}

// Settle all entropy contracts.
// Each contract holds {id, lockedMult, size, premium}.
// Payout = size * max(0, currentMult - lockedMult).
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
