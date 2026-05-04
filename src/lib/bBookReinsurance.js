// B-book reinsurance pool — protects layer-3 (B-book underwriter)
// drawdowns on a FLOAT thread.
//
// Why this exists
// ---------------
// The four-layer thread mechanic puts the user's principal in four
// roles simultaneously. Layer 2 (insurance-seller) has reinsurance
// available (lib/reinsurance.js) so the user can hedge insurer-side
// losses. Layer 3 (B-book pool stake) has no equivalent — until this
// module. The Tier 1.1 harness extension showed that without a layer-3
// hedge, sustained losing streaks on B-book (P(joint ≥ 0) ≈ 2%) and
// fat-tail coordinated retail wins (P(joint ≥ 0) ≈ 14%) catastrophically
// break the safety claim.
//
// Mechanism
// ---------
// Single product (not three, unlike insurance reinsurance). The
// failure mode is one risk surface — coordinated retail wins eating
// pool capital — and there's no natural way to slice it into
// independent fractions, so the multi-product structure of insurance
// reinsurance (which covers many uncorrelated events) doesn't apply
// here. Failure isolation is handled via per-seller exposure caps
// inside the single product instead.
//
// Two sides:
//   - Buyer (= FLOAT minter, auto-bought during mint): pays per-tick
//     premium proportional to coverage face. Receives payouts when
//     pool NAV drops below the trigger threshold.
//   - Seller (= capital provider): posts capital that funds payouts.
//     Earns premium pro-rata. Subject to a long lockup matching the
//     insurance reinsurance discipline (200 ticks).
//
// Trigger and coverage shape
// --------------------------
// High-water-mark stop-loss on the user's cumulative B-book P&L.
// The harness passes the user's per-tick B-book P&L (positive =
// gain, negative = loss) to the settlement function. The product
// maintains per-buyer cumulative P&L + peak, and computes drawdown
// as (peak - current).
//
// Coverage layer: the portion of drawdown BETWEEN attachment and
// exhaustion is covered. Below attachment (typical noise) is
// uninsured; above exhaustion is uninsured (catastrophic — beyond
// the policy).
//
// Critically, this only sees BOOK-LOSS P&L — the harness explicitly
// passes in B-book P&L, separate from insurance-driven thread damage
// (which already has its own reinsurance) and T-bill growth.
//
// Per-tick payout = max(0, currentLayerExposure - alreadyPaid)
// where currentLayerExposure = clamp(drawdown, 0, exhaustion - attachment)
// (in dollars). New peak resets alreadyPaid (recovery → fresh
// drawdown cycle).
//
// Pricing
// -------
// Same supply/demand √ formula as insurance markets. Base rate
// independently calibrated; matches the reinsurance pricing pattern.

import {
  postInsurer,
  withdrawInsurer,
  postInsured,
  cancelInsured,
} from "./insuranceMarket.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Per insurance settlement (every INSURANCE_STRIDE medium ticks).
// Calibrated to be similar in magnitude to insurance reinsurance —
// covers a different risk surface but has comparable seller economics.
//
// Note: B-book reinsurance settles on the LAP STRIDE (the off-stride
// from insurance), so the rate is per-LAP-tick. With INSURANCE_STRIDE = 2,
// LAP ticks = INSURANCE_STRIDE - 1 = 1 every other medium tick. The
// per-tick scale is the same.
export const BBOOK_REINS_BASE_RATE = 0.0002;
export const BBOOK_REINS_LOCKUP_EPOCHS = 200;

// Stop-loss attachment (drawdown that's uninsured at the bottom):
// expressed as a fraction of buyer face. Default 0.10 = first 10%
// of face is the deductible (≈ typical-noise drawdown).
export const BBOOK_REINS_ATTACHMENT_FRAC = 0.10;

// Stop-loss exhaustion (drawdown above which coverage runs out):
// expressed as a fraction of buyer face. Default 1.0 = up to face
// covered. Combined with attachment, the covered layer is 0.10–1.0
// of face = 90% of face in dollars.
export const BBOOK_REINS_EXHAUSTION_FRAC = 1.0;

// Default auto-buy face fraction during FLOAT mint. face = principal ×
// this fraction. Default 0.30 covers a 30% drawdown layer of the
// user's threadDerivedStake.
export const BBOOK_REINS_DEFAULT_FACE_FRACTION = 0.30;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeBBookReinsuranceProduct() {
  return {
    id: _uid("BBOOK-REINS"),
    label: "B-book Reinsurance",
    attachmentFrac: BBOOK_REINS_ATTACHMENT_FRAC,
    exhaustionFrac: BBOOK_REINS_EXHAUSTION_FRAC,
    sellerPositions: {},
    sellerCapital: 0,
    sellerLockupReleaseEpoch: {},
    buyerCoverage: {},
    totalCoverage: 0,
    premiumRate: BBOOK_REINS_BASE_RATE,
    // High-water-mark stop-loss bookkeeping, per buyer:
    //   cumulativePnlByUser  — running total of per-tick B-book P&L
    //   peakPnlByUser        — highest cumulative P&L seen (HWM)
    //   paidThisDrawdownByUser — payouts inside the current drawdown,
    //                            reset when peak rises (new HWM)
    cumulativePnlByUser: {},
    peakPnlByUser: {},
    paidThisDrawdownByUser: {},
    cumulativePremiums: 0,
    cumulativePayouts: 0,
    triggerEvents: 0,
    lastTickEpoch: -1,
  };
}

// ---------------------------------------------------------------------------
// Posting / withdrawing — reuse insurance-market helpers
// ---------------------------------------------------------------------------

export function postBBookReinsuranceSeller({
  product,
  userId,
  amount,
  currentEpoch,
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  const stake = postInsurer({
    market: {
      ...product,
      insurerPositions: product.sellerPositions,
      insurerCapital: product.sellerCapital,
    },
    userId,
    amount,
  });
  if (!stake.ok) return stake;
  const release = (currentEpoch ?? 0) + BBOOK_REINS_LOCKUP_EPOCHS;
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

export function withdrawBBookReinsuranceSeller({
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
    bypassLockup: true,
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

export function postBBookReinsuranceBuyer({ product, userId, faceAmount }) {
  const r = postInsured({
    market: {
      ...product,
      coverage: product.buyerCoverage,
      totalCoverage: product.totalCoverage,
    },
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

export function cancelBBookReinsuranceBuyer({
  product,
  userId,
  faceAmount = null,
}) {
  const r = cancelInsured({
    market: {
      ...product,
      coverage: product.buyerCoverage,
      totalCoverage: product.totalCoverage,
    },
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

export function calcBBookReinsurancePremiumRate(product) {
  const base = BBOOK_REINS_BASE_RATE;
  const ins = product.sellerCapital;
  const cov = product.totalCoverage;
  if (ins <= 0 || cov <= 0) return base;
  const ratio = cov / ins;
  const SENS = 0.5;
  const raw = base * Math.pow(ratio, SENS);
  return Math.max(base * 0.01, Math.min(base * 10, raw));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

// Per LAP-stride tick, given each buyer's B-book P&L this tick
// (positive = gain, negative = loss), update the high-water-mark
// stop-loss bookkeeping and pay out covered drawdown.
//
// Inputs:
//   product           — current product state
//   bBookPnlByUser    — { userId: signed P&L this tick }
//                       Only B-book P&L, not insurance damage.
//   currentEpoch
//
// Returns: { product, payouts, sellerLosses, premiumIn, premiumOut, logs }
export function settleBBookReinsuranceTick({
  product,
  bBookPnlByUser = {},
  currentEpoch,
}) {
  const logs = [];
  const payouts = {};
  const sellerLosses = {};
  const premiumOut = {};
  const premiumIn = {};

  let nextSellerCapital = product.sellerCapital;
  let nextSellerPositions = product.sellerPositions;
  const nextCumPnl = { ...(product.cumulativePnlByUser ?? {}) };
  const nextPeak = { ...(product.peakPnlByUser ?? {}) };
  const nextPaidThisDrawdown = { ...(product.paidThisDrawdownByUser ?? {}) };

  // ---- HWM update + payout computation ----
  let totalPayout = 0;
  for (const [uid, face] of Object.entries(product.buyerCoverage)) {
    if (face <= 0) continue;
    const pnl = bBookPnlByUser[uid] ?? 0;
    const oldCum = nextCumPnl[uid] ?? 0;
    const newCum = oldCum + pnl;
    const oldPeak = nextPeak[uid] ?? 0;
    let newPeak = oldPeak;
    let paid = nextPaidThisDrawdown[uid] ?? 0;
    if (newCum > oldPeak) {
      newPeak = newCum;
      paid = 0; // recovery: fresh drawdown cycle
    }
    nextCumPnl[uid] = newCum;
    nextPeak[uid] = newPeak;

    const drawdown = Math.max(0, newPeak - newCum);
    const attachmentDollars = face * (product.attachmentFrac ?? 0);
    const exhaustionDollars = face * (product.exhaustionFrac ?? 1);
    const layeredExposure = Math.max(
      0,
      Math.min(drawdown, exhaustionDollars) - attachmentDollars
    );
    const incrementalPayout = Math.max(0, layeredExposure - paid);
    if (incrementalPayout > 1e-9) {
      payouts[uid] = (payouts[uid] ?? 0) + incrementalPayout;
      paid += incrementalPayout;
      totalPayout += incrementalPayout;
    }
    nextPaidThisDrawdown[uid] = paid;
  }

  if (totalPayout > 0 && product.sellerCapital > 0) {
    const haircut = Math.min(1, product.sellerCapital / totalPayout);
    if (haircut < 1) {
      for (const [uid, p] of Object.entries(payouts)) {
        payouts[uid] = p * haircut;
      }
      logs.push(
        `[BBOOK-REINS] pot exhausted (haircut ${(haircut * 100).toFixed(0)}%)`
      );
    }
    const realisedPayout = totalPayout * haircut;
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
  const rate = calcBBookReinsurancePremiumRate({
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
      cumulativePnlByUser: nextCumPnl,
      peakPnlByUser: nextPeak,
      paidThisDrawdownByUser: nextPaidThisDrawdown,
      premiumRate: rate,
      cumulativePremiums: (product.cumulativePremiums ?? 0) + totalPremium,
      cumulativePayouts: (product.cumulativePayouts ?? 0) + totalPayout,
      triggerEvents: (product.triggerEvents ?? 0) + (totalPayout > 0 ? 1 : 0),
      lastTickEpoch: currentEpoch,
    },
    payouts,
    sellerLosses,
    premiumOut,
    premiumIn,
    logs,
  };
}
