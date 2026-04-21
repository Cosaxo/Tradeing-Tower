// Conservation assertion — whitepaper §9.
//
// After every medium epoch: Σ payouts + tipsEscrowed ≤ totalPoolDeposit + ε
//
// Violations are flagged in the settlement log. In normal operation the
// retained amount (totalIn − totalOut − tips) is positive and represents
// absorbed losses — the pool honours the identity "money in ≥ money out."

const EPSILON = 0.01;

// Check the conservation identity for one epoch.
// Inputs:
//   totalIn        — all inflows to pool (premiums, stability fee, rent)
//   totalOut       — all outflows (claims, depositor distributions)
//   tipsEscrowed   — total tip revenue escrowed to minority (not pool-backed)
//   totalPoolDeposit — current pool deposits capacity
export function checkConservation({ totalIn, totalOut, tipsEscrowed, totalPoolDeposit }) {
  const claimed = totalOut + tipsEscrowed;
  const backing = totalPoolDeposit + totalIn;
  const retained = backing - claimed;
  const violated = claimed > backing + EPSILON;
  return {
    ok: !violated,
    retained,
    claimed,
    backing,
    violated,
    epsilon: EPSILON,
  };
}

// Format one epoch's conservation result for the log stream.
export function formatConservationLog(pairKey, result) {
  if (result.violated) {
    return `[CONSERVATION VIOLATED] ${pairKey}: claimed $${result.claimed.toFixed(2)} > backing $${result.backing.toFixed(2)} (diff $${(result.claimed - result.backing).toFixed(4)})`;
  }
  return `[CONSERVATION OK] ${pairKey}: retained $${result.retained.toFixed(2)} (claimed $${result.claimed.toFixed(2)} ≤ backing $${result.backing.toFixed(2)})`;
}
