// Credit hard-floor + pair eligibility — what's left after the legacy
// composition/gates/multiplier system was folded into pool LTV.
//
// The new credit story lives in `ltv.js`: pool deposit + portfolio-scaled
// LTV produces a pool-credit budget that funds tethered LAPs. The
// performance gates, drift detection, drift-decayed multiplier, and the
// per-pair multiplier-driven leverage extension are gone. What remains:
//
// 1. `shouldUnwindCredit` — solvency floor. If own equity falls to (or
//    below) deployed credit, the system is insolvent for this user and
//    must auto-deleverage. Cheap, important, kept.
//
// 2. `calcPairCreditEligibility` — sanity rule preventing the same
//    long+short hedge being opened with credit on a single pair twice.
//    Independent of the score; kept.

export function shouldUnwindCredit(ownEquity, deployedCredit) {
  if (deployedCredit <= 0) return false;
  return ownEquity <= deployedCredit;
}

// Per-pair eligibility check used at open time. After the legacy multiplier
// was cut, there's no `creditScore` to gate on, so the rule is purely
// structural: don't let one user stack a long AND a short of the same pair
// using credit (that's a paired position, which Phase 2 introduces as a
// distinct primitive).
export function calcPairCreditEligibility(pairKey, openPositions) {
  const openPairs = openPositions.map((p) => p.pairKey);
  if (openPairs.filter((p) => p === pairKey).length >= 2) {
    return { eligible: false, reason: "Already holds long+short on this pair" };
  }
  return { eligible: true };
}
