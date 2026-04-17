// Yield strip settlement.
//
// A strip is a forward yield contract: the buyer pays a premium now and
// receives a payout proportional to the realised yield over the strip's
// remaining epochs, capped by the insurer's book size.

import { calcStripPremium, calcYieldStripValue } from "./yieldModel.js";
import { TBILL_RATE } from "../constants/system.js";

export const MAX_INSURER_BOOK_PCT = 0.25; // insurer can back at most 25% of their margin

// Create a new strip order.
export function initStrip({
  id,
  leverage,
  margin,
  epochs,
  realizedSigma,
  threshold = 0.2,
  protectedFraction = 0.5,
  returnHistory = [],
  yieldModel = null,
  discountRate = TBILL_RATE,
}) {
  const premium = calcStripPremium(leverage, realizedSigma, threshold, protectedFraction, returnHistory);
  const pv = calcYieldStripValue(premium * 100, margin, epochs, discountRate, yieldModel);
  return {
    id,
    leverage,
    margin,
    epochs,
    remainingEpochs: epochs,
    threshold,
    protectedFraction,
    premium,
    presentValue: pv,
    cumulativePayout: 0,
    active: true,
  };
}

// Settle all active strips for one epoch.
// insurerMargin limits total claims the insurer can cover.
export function settleStrips(strips, realizedYield, realizedSigma, returnHistory, insurerMargin) {
  const logs = [];
  let totalPremiumCollected = 0;
  let totalPayout = 0;
  const maxInsurableExposure = (insurerMargin ?? 0) * MAX_INSURER_BOOK_PCT;

  const settled = strips.map((s) => {
    if (!s.active || s.remainingEpochs <= 0) return { ...s, active: false };

    // Premium collected this epoch.
    const epochPremium = s.margin * s.premium;
    totalPremiumCollected += epochPremium;

    // Payout triggered if yield exceeds strip threshold (i.e., large loss event).
    const lossFraction = Math.max(0, realizedSigma - s.threshold);
    const payout = lossFraction > 0
      ? Math.min(
          maxInsurableExposure - totalPayout,
          s.margin * s.protectedFraction * lossFraction * 10
        )
      : 0;

    if (payout > 0) {
      totalPayout += payout;
      logs.push(
        `[STRIP] ${s.id} triggered: sigma=${realizedSigma.toFixed(4)} > threshold=${s.threshold} | payout=$${payout.toFixed(2)}`
      );
    }

    const newRemaining = s.remainingEpochs - 1;
    return {
      ...s,
      remainingEpochs: newRemaining,
      active: newRemaining > 0,
      cumulativePayout: s.cumulativePayout + payout,
      lastPayout: payout,
      lastPremium: epochPremium,
    };
  });

  void realizedYield; // reserved for OU-model premium updates
  void returnHistory;

  logs.push(
    `[STRIPS] premium=$${totalPremiumCollected.toFixed(2)} payout=$${totalPayout.toFixed(2)} active=${settled.filter((s) => s.active).length}`
  );

  return { settled, totalPremiumCollected, totalPayout, logs };
}
