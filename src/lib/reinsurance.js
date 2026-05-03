// Reinsurance — three parallel two-sided products that protect insurance
// SELLERS against the claims they have to pay out.
//
// FUTURE WORK (noted Sprint 4.5): the protocol's safety claim covers
// the joint outcome across all four thread layers. Today reinsurance
// only protects the insurance-seller leg (layer 2). Layer 3 — the
// B-book pool stake — has no equivalent hedge, so a wave of profitable
// retail flow can drain the B-book pool and damage the thread without
// any reimbursement. A *B-book reinsurance pool* (or a generalisation
// of these products to cover B-book drawdowns) is the next coverage
// gap to close. Out of scope for this sprint.
//
// Structure
// ---------
//
// There are exactly three reinsurance products, declared in
// REINSURANCE_PRODUCTS below. They run in PARALLEL — when an insurance
// claim hits a buyer (someone who is an insurance seller and has bought
// reinsurance), each of the three reinsurance products pays a fixed
// FRACTION of the loss back. The fractions sum to 1.0 by default
// (30 % + 30 % + 40 %), so a fully-reinsured seller is fully-covered.
//
// Two-sided like insurance:
//
//   - Reinsurance buyer: pays per-epoch premium proportional to the
//     amount of insurance-seller exposure they want covered. Receives
//     coverageFraction × insuranceLoss when their insurance claims
//     trigger.
//
//   - Reinsurance seller: posts capital that funds payouts. Earns
//     premium income pro-rata. Has a SLOW WITHDRAWAL — capital is
//     locked for REINSURANCE_LOCKUP_EPOCHS after deposit (much longer
//     than the insurance pool lockup), reflecting that reinsurance is
//     the system's last line of defence and must remain reliably
//     present.
//
// Pricing
// -------
//
// Same supply/demand spread as insurance markets, but with a higher
// base rate (reinsurance covers tail risk → costs more).

import {
  postInsurer,
  withdrawInsurer,
  postInsured,
  cancelInsured,
} from "./insuranceMarket.js";

// ---------------------------------------------------------------------------
// Product registry
// ---------------------------------------------------------------------------

export const REINSURANCE_PRODUCTS = [
  { id: "REINS-1", label: "Reinsurance A", coverageFraction: 0.30 },
  { id: "REINS-2", label: "Reinsurance B", coverageFraction: 0.30 },
  { id: "REINS-3", label: "Reinsurance C", coverageFraction: 0.40 },
];

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Reinsurance base rate. Calibrated in Sprint 4.5: previously
// 0.010/tick (≈365% annualised) which made the auto-mint user's
// reinsurance premium cost dominate every joint-outcome scenario.
// Reduced 100× to 0.0001/tick (≈3.65% annualised at base).
//
// Note on the relative pricing: this base is now LOWER than
// BASE_PREMIUM_RATE (0.00015 after Sprint 4.5b). That looks
// counter-intuitive ("reinsurance should be more expensive — it
// covers tail risk") but it's correct for diversified buyers like
// the auto-mint user. Reinsurance pools many uncorrelated insurance
// risks; the diversification benefit accrues to the seller pool, so
// the per-buyer rate is below the price of any single primary
// insurance product. A concentrated buyer hedging only one event
// would be priced higher via the cov/ins √ scaling, restoring the
// "tail risk costs more" relationship for that user.
export const REINSURANCE_BASE_RATE = 0.0001;
export const REINSURANCE_LOCKUP_EPOCHS = 200;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// Build the standard set of three reinsurance products. Each carries
// the same shape as an insurance market but with extra fields
// (coverageFraction, sellerLockup) and tracks per-seller deposit
// epochs so withdrawals can be gated on lockup.
export function makeReinsuranceSet() {
  return REINSURANCE_PRODUCTS.map((product) => ({
    id: _uid("REINS"),
    productId: product.id,
    label: product.label,
    coverageFraction: product.coverageFraction,
    // Insurer (= reinsurance seller) side. { userId: stake }
    sellerPositions: {},
    sellerCapital: 0,
    // Per-user lockup tracking: when can each user withdraw?
    sellerLockupReleaseEpoch: {},
    // Buyer (= reinsurance buyer) side. { userId: face }
    buyerCoverage: {},
    totalCoverage: 0,
    // Live premium rate.
    premiumRate: REINSURANCE_BASE_RATE,
    // Bookkeeping.
    cumulativePremiums: 0,
    cumulativePayouts: 0,
    triggerEvents: 0,
    lastTickEpoch: -1,
  }));
}

// ---------------------------------------------------------------------------
// Posting / withdrawing
// ---------------------------------------------------------------------------

export function postReinsuranceSeller({
  product,
  userId,
  amount,
  currentEpoch,
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  // Reuse insuranceMarket helpers for the position math, then attach
  // the lockup-release epoch.
  const stake = postInsurer({
    market: { ...product, insurerPositions: product.sellerPositions, insurerCapital: product.sellerCapital },
    userId,
    amount,
  });
  if (!stake.ok) return stake;
  const release = (currentEpoch ?? 0) + REINSURANCE_LOCKUP_EPOCHS;
  // We keep the LATEST release epoch so additional deposits push the
  // unlock further out — prevents drip-deposits from short-circuiting
  // the lockup.
  const existingRelease = product.sellerLockupReleaseEpoch?.[userId] ?? 0;
  return {
    ok: true,
    product: {
      ...product,
      sellerPositions: stake.market.insurerPositions,
      sellerCapital: stake.market.insurerCapital,
      sellerLockupReleaseEpoch: {
        ...product.sellerLockupReleaseEpoch,
        [userId]: Math.max(existingRelease, release),
      },
    },
  };
}

export function withdrawReinsuranceSeller({
  product,
  userId,
  amount,
  currentEpoch,
}) {
  const release = product.sellerLockupReleaseEpoch?.[userId] ?? 0;
  if (currentEpoch < release) {
    return {
      ok: false,
      reason: `locked until epoch ${release} (currently ${currentEpoch})`,
    };
  }
  const w = withdrawInsurer({
    market: {
      ...product,
      insurerPositions: product.sellerPositions,
      insurerCapital: product.sellerCapital,
    },
    userId,
    amount,
  });
  if (!w.ok) return w;
  const newReleases = { ...product.sellerLockupReleaseEpoch };
  if (!w.market.insurerPositions[userId]) delete newReleases[userId];
  return {
    ok: true,
    product: {
      ...product,
      sellerPositions: w.market.insurerPositions,
      sellerCapital: w.market.insurerCapital,
      sellerLockupReleaseEpoch: newReleases,
    },
  };
}

export function postReinsuranceBuyer({ product, userId, faceAmount }) {
  const r = postInsured({
    market: { ...product, coverage: product.buyerCoverage, totalCoverage: product.totalCoverage },
    userId,
    faceAmount,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    product: {
      ...product,
      buyerCoverage: r.market.coverage,
      totalCoverage: r.market.totalCoverage,
    },
  };
}

export function cancelReinsuranceBuyer({ product, userId, faceAmount = null }) {
  const r = cancelInsured({
    market: { ...product, coverage: product.buyerCoverage, totalCoverage: product.totalCoverage },
    userId,
    faceAmount,
  });
  if (!r.ok) return r;
  return {
    ok: true,
    cancelledFace: r.cancelledFace,
    product: {
      ...product,
      buyerCoverage: r.market.coverage,
      totalCoverage: r.market.totalCoverage,
    },
  };
}

// ---------------------------------------------------------------------------
// Premium rate
// ---------------------------------------------------------------------------

export function calcReinsurancePremiumRate(product) {
  // Reuse the insurance-market shape: feed seller stake as insurerCapital
  // and totalCoverage as totalCoverage. The rate function is the same
  // shape; we just override the base rate via the embedded constants
  // (insuranceMarket uses BASE_PREMIUM_RATE; we adjust by ratio).
  const base = REINSURANCE_BASE_RATE;
  const ins = product.sellerCapital;
  const cov = product.totalCoverage;
  if (ins <= 0 || cov <= 0) return base;
  // Same √(cov/ins) shape as insurance markets, just on a different
  // base. Floor relaxed in Sprint 4.5b from 0.1× to 0.01× so heavily-
  // oversupplied reinsurance markets can clear at sub-T-bill rates
  // and self-correct via seller exit. MAX stays at 10× base.
  const ratio = cov / ins;
  const SENS = 0.5;
  const raw = base * Math.pow(ratio, SENS);
  return Math.max(base * 0.01, Math.min(base * 10, raw));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

// Per-tick reinsurance settlement.
//
// Inputs:
//   product           — reinsurance product state
//   buyerLossesByUser — map from userId → insurance loss they incurred
//                       this tick (positive numbers; sum of all the
//                       claim payouts they had to make as insurance
//                       sellers).
//   currentEpoch
//
// Behavior:
//
//   1. PAYOUT pass: each buyer who has buyerCoverage and is in
//      buyerLossesByUser receives min(coverage, coverageFraction × loss).
//      That dollar amount is debited from sellerCapital pro-rata to
//      seller stake.
//
//   2. PREMIUM pass: every buyer pays premium = coverage × rate this
//      tick. Sellers receive pro-rata.
//
// Returns:
//   { product, payouts, sellerLosses, premiumOut, premiumIn, logs }
export function settleReinsuranceTick({
  product,
  buyerLossesByUser = {},
  currentEpoch,
}) {
  const logs = [];
  const payouts = {};
  const sellerLosses = {};
  const premiumOut = {};
  const premiumIn = {};

  // ---- payout pass ----
  let totalPayout = 0;
  for (const [uid, loss] of Object.entries(buyerLossesByUser)) {
    if (!loss || loss <= 0) continue;
    const cov = product.buyerCoverage[uid] ?? 0;
    if (cov <= 0) continue;
    // Pay min of: their face coverage, and the coverageFraction × loss.
    const targetPayout = Math.min(cov, product.coverageFraction * loss);
    payouts[uid] = (payouts[uid] ?? 0) + targetPayout;
    totalPayout += targetPayout;
  }

  let nextSellerCapital = product.sellerCapital;
  let nextSellerPositions = product.sellerPositions;

  if (totalPayout > 0 && product.sellerCapital > 0) {
    // Haircut sellers if the pot can't cover the full payout.
    const haircut = Math.min(1, product.sellerCapital / totalPayout);
    if (haircut < 1) {
      // Scale down each user's payout pro-rata.
      const scaled = {};
      for (const [uid, p] of Object.entries(payouts)) {
        scaled[uid] = p * haircut;
      }
      Object.assign(payouts, scaled);
      logs.push(
        `[REINS-PAYOUT] ${product.productId}: pot exhausted (haircut ${(haircut * 100).toFixed(0)}%)`
      );
    }
    const realisedPayout = totalPayout * haircut;
    // Reduce seller positions pro-rata.
    const newPositions = {};
    for (const [uid, stake] of Object.entries(product.sellerPositions)) {
      const share = stake / product.sellerCapital;
      const loss = share * realisedPayout;
      sellerLosses[uid] = (sellerLosses[uid] ?? 0) + loss;
      const next = stake - loss;
      if (next > 1e-9) newPositions[uid] = next;
    }
    nextSellerPositions = newPositions;
    nextSellerCapital = Math.max(0, product.sellerCapital - realisedPayout);
  }

  // ---- premium pass ----
  const rate = calcReinsurancePremiumRate({
    ...product,
    sellerCapital: nextSellerCapital,
  });
  let totalPremium = 0;
  for (const [uid, cov] of Object.entries(product.buyerCoverage)) {
    if (cov <= 0) continue;
    const fee = cov * rate;
    premiumOut[uid] = (premiumOut[uid] ?? 0) + fee;
    totalPremium += fee;
  }
  if (totalPremium > 0 && nextSellerCapital > 0) {
    for (const [uid, stake] of Object.entries(nextSellerPositions)) {
      const share = stake / nextSellerCapital;
      const earn = share * totalPremium;
      premiumIn[uid] = (premiumIn[uid] ?? 0) + earn;
    }
  }

  return {
    product: {
      ...product,
      sellerPositions: nextSellerPositions,
      sellerCapital: nextSellerCapital,
      premiumRate: rate,
      cumulativePremiums: (product.cumulativePremiums ?? 0) + totalPremium,
      cumulativePayouts: (product.cumulativePayouts ?? 0) + totalPayout,
      triggerEvents:
        (product.triggerEvents ?? 0) + (totalPayout > 0 ? 1 : 0),
      lastTickEpoch: currentEpoch,
    },
    payouts,
    sellerLosses,
    premiumOut,
    premiumIn,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

// Total reinsurance coverage held by `userId` across all 3 products.
// Useful for the 1.5× rule: TT-mint can only enter insurance markets
// where potential payout < 1.5 × user's reinsurance coverage on that
// loss.
export function totalReinsuranceCoverage(products, userId) {
  let s = 0;
  for (const p of products) s += p.buyerCoverage?.[userId] ?? 0;
  return s;
}

// Combined coverage *fraction* — what % of any incurred loss this
// user would receive across all 3 reinsurance products. Buyer of all
// 3 with sufficient face → 1.0 (fully reinsured).
export function effectiveCoverageFraction(products, userId, lossEstimate) {
  if (!lossEstimate || lossEstimate <= 0) return 0;
  let total = 0;
  for (const p of products) {
    const cov = p.buyerCoverage?.[userId] ?? 0;
    if (cov <= 0) continue;
    total += Math.min(cov, p.coverageFraction * lossEstimate);
  }
  return Math.min(1, total / lossEstimate);
}
