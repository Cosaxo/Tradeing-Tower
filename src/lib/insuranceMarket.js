// Insurance market — one per protocol-defined event.
//
// Two-sided binary-payout product:
//
//   - Insurer side: posts capital that will be paid out if the event
//     triggers. Earns a per-epoch premium stream from buyers in
//     exchange. Same-capital semantics: the posted amount is
//     committed, not transferred — released only if the participant
//     unwinds before a trigger.
//
//   - Insured side: buys "coverage" (face value). Pays a per-epoch
//     premium proportional to face × premiumRate. On trigger, receives
//     face value (pro-rata haircut if the insurer pool can't cover
//     the total face).
//
// Pricing follows supply/demand: more buyer demand vs insurer supply
// pushes the premium rate up; the inverse pulls it down.
//
// All functions are pure — they take state in, return new state. The
// caller (useEpochLoop) translates the abstract premium / payout
// numbers into concrete cash flows on participant margins.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Insurer-side lockup — direct insurer-stake withdrawals respect this
// many medium ticks of cool-down from the latest deposit. Prevents
// in-and-out-around-trigger gaming where a user deposits, collects
// premium, then withdraws right before a likely trigger.
//
// Thread-backed insurer stakes — those posted as part of a TT mint —
// are governed by the redemption mechanics (10% cycle cap or 5%
// express penalty), not this lockup, so withdrawInsurer accepts a
// `bypassLockup: true` flag for those paths.
export const INSURANCE_LOCKUP_EPOCHS = 200;

// Base premium rate PER INSURANCE SETTLEMENT (every INSURANCE_STRIDE
// medium ticks, currently 2). Sensitivity controls how aggressively
// imbalance shifts the rate.
//
// Tier 1.0 (epoch-separation): insurance settles every other medium
// tick now, so each settlement is for a 2-tick period. Base rate
// doubled from 0.00015 (per-tick) to 0.0003 (per-settlement) to keep
// annualised yield constant — total premium income per year is
// unchanged, just collected in fewer larger chunks.
//
// Sprint 4.5b: BASE was bumped from 0.00005/tick to 0.00015/tick to
// put insurance underwriting yield (5.5% annualised at balance)
// competitively above T-bill (4%), and the MIN floor was relaxed to
// 0.01× base so heavily oversupplied markets can self-correct via
// natural seller exit. MAX stays at 10× base.
export const BASE_PREMIUM_RATE = 0.0003;
export const PREMIUM_SENSITIVITY = 0.5;
export const MIN_PREMIUM_RATE = 0.000003;
export const MAX_PREMIUM_RATE = 0.003;

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeInsuranceMarket({ eventId, pairKey = null, category }) {
  return {
    id: _uid("INS-MKT"),
    eventId,
    pairKey,
    category,
    // Insurer side: { userId: stake }. Sum = insurerCapital.
    insurerPositions: {},
    insurerCapital: 0,
    // Insured side: { userId: faceAmount }. Sum = totalCoverage.
    coverage: {},
    totalCoverage: 0,
    // Live rate, recomputed each tick.
    premiumRate: BASE_PREMIUM_RATE,
    // Bookkeeping.
    cumulativePremiums: 0,
    cumulativeClaims: 0,
    triggerCount: 0,
    lastTickEpoch: -1,
    // Per-insurer lockup release epoch. postInsurer extends this on
    // each deposit; withdrawInsurer respects it unless bypassLockup
    // is set. Keys absent → no lockup recorded → withdraw freely.
    insurerLockupReleaseEpoch: {},
  };
}

// ---------------------------------------------------------------------------
// Posting / withdrawing positions
// ---------------------------------------------------------------------------

// Insurer-side: commit capital that will pay out on trigger.
// Returns { ok, market, reason? }.
//
// `currentEpoch` (optional) extends the per-user lockup release
// epoch. Latest deposit pushes the unlock further out, so drip
// deposits can't short-circuit the lockup. Backward-compatible —
// callers that don't pass currentEpoch get no lockup recorded.
export function postInsurer({ market, userId, amount, currentEpoch }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  let nextLockup = market.insurerLockupReleaseEpoch ?? {};
  if (Number.isFinite(currentEpoch)) {
    const release = currentEpoch + INSURANCE_LOCKUP_EPOCHS;
    const existing = nextLockup[userId] ?? 0;
    nextLockup = { ...nextLockup, [userId]: Math.max(existing, release) };
  }
  return {
    ok: true,
    market: {
      ...market,
      insurerPositions: {
        ...market.insurerPositions,
        [userId]: (market.insurerPositions[userId] ?? 0) + amount,
      },
      insurerCapital: market.insurerCapital + amount,
      insurerLockupReleaseEpoch: nextLockup,
    },
  };
}

// Withdraw insurer-side capital. Respects the per-user lockup unless
// `bypassLockup: true` is set.
//
// bypassLockup paths (thread-driven, gated by redemption mechanics):
//   - insurance damage propagation across covered markets
//   - TT redemption thread unwinds
// Direct-user withdrawal paths leave bypassLockup false and pass
// `currentEpoch` so the lockup is enforced.
export function withdrawInsurer({
  market,
  userId,
  amount,
  currentEpoch,
  bypassLockup = false,
}) {
  const have = market.insurerPositions[userId] ?? 0;
  if (amount > have + 1e-9) {
    return { ok: false, reason: "amount exceeds posted insurer stake" };
  }
  if (!bypassLockup && Number.isFinite(currentEpoch)) {
    const release = market.insurerLockupReleaseEpoch?.[userId] ?? 0;
    if (currentEpoch < release) {
      return {
        ok: false,
        reason: `locked until epoch ${release} (currently ${currentEpoch})`,
      };
    }
  }
  const newPositions = { ...market.insurerPositions };
  const newLockup = { ...(market.insurerLockupReleaseEpoch ?? {}) };
  if (have - amount <= 1e-9) {
    delete newPositions[userId];
    delete newLockup[userId];
  } else {
    newPositions[userId] = have - amount;
  }
  return {
    ok: true,
    market: {
      ...market,
      insurerPositions: newPositions,
      insurerCapital: Math.max(0, market.insurerCapital - amount),
      insurerLockupReleaseEpoch: newLockup,
    },
  };
}

// Insured-side: buy `faceAmount` of coverage. Buyer pays premium each
// tick on this face; receives face on trigger (pro-rata-haircut if
// insurer pool can't cover totalCoverage).
export function postInsured({ market, userId, faceAmount }) {
  if (!Number.isFinite(faceAmount) || faceAmount <= 0) {
    return { ok: false, reason: "faceAmount must be positive" };
  }
  return {
    ok: true,
    market: {
      ...market,
      coverage: {
        ...market.coverage,
        [userId]: (market.coverage[userId] ?? 0) + faceAmount,
      },
      totalCoverage: market.totalCoverage + faceAmount,
    },
  };
}

// Cancel coverage. Returns face amount unwound.
export function cancelInsured({ market, userId, faceAmount = null }) {
  const have = market.coverage[userId] ?? 0;
  if (have <= 0) return { ok: false, reason: "no coverage held" };
  const cancel = faceAmount == null ? have : Math.min(faceAmount, have);
  const newCoverage = { ...market.coverage };
  if (have - cancel <= 1e-9) delete newCoverage[userId];
  else newCoverage[userId] = have - cancel;
  return {
    ok: true,
    market: {
      ...market,
      coverage: newCoverage,
      totalCoverage: Math.max(0, market.totalCoverage - cancel),
    },
    cancelledFace: cancel,
  };
}

// ---------------------------------------------------------------------------
// Premium rate update
// ---------------------------------------------------------------------------

// Premium rate as a function of insurer/insured imbalance:
//
//   rate = clamp(BASE × (insured / insurer)^SENSITIVITY, MIN, MAX)
//
// At perfect balance → BASE. 2× demand → BASE × √2 (≈ 1.41 ×).
export function calcPremiumRate(market) {
  const ins = market.insurerCapital;
  const cov = market.totalCoverage;
  if (ins <= 0 || cov <= 0) return BASE_PREMIUM_RATE;
  const ratio = cov / ins;
  const raw = BASE_PREMIUM_RATE * Math.pow(ratio, PREMIUM_SENSITIVITY);
  return Math.max(MIN_PREMIUM_RATE, Math.min(MAX_PREMIUM_RATE, raw));
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

// Per-tick settlement.
//
// If the linked event triggered this tick:
//   - Each insured user receives min(faceAmount, faceShare × insurerCapital).
//   - Each insurer user loses pro-rata share of insurerCapital.
//   - The market resets its capital + coverage but keeps participants
//     who haven't withdrawn (they're zeroed but the user records
//     remain for ledger purposes).
//
// Otherwise (no trigger):
//   - Each insured user pays premium = faceAmount × premiumRate per tick.
//   - Each insurer user receives premium pro-rata to their stake.
//
// Returns:
//   { market, premiumOut: { userId: paid }, premiumIn: { userId: received },
//     claimOut: { userId: paid (insurer loss) }, claimIn: { userId: received },
//     logs }
export function settleMarketTick({ market, eventTriggered, currentEpoch }) {
  const logs = [];
  const premiumOut = {};
  const premiumIn = {};
  const claimOut = {};
  const claimIn = {};

  if (eventTriggered) {
    if (market.totalCoverage > 0 && market.insurerCapital > 0) {
      const haircut = Math.min(1, market.insurerCapital / market.totalCoverage);
      const totalPaid = market.totalCoverage * haircut;

      // Pay each insured pro-rata.
      for (const [uid, face] of Object.entries(market.coverage)) {
        const payout = face * haircut;
        if (payout > 0) claimIn[uid] = (claimIn[uid] ?? 0) + payout;
      }

      // Charge insurers pro-rata to their stake.
      for (const [uid, stake] of Object.entries(market.insurerPositions)) {
        const share = stake / market.insurerCapital;
        const loss = share * totalPaid;
        if (loss > 0) claimOut[uid] = (claimOut[uid] ?? 0) + loss;
      }

      logs.push(
        `[INS-TRIGGER] ${market.eventId}: $${totalPaid.toFixed(2)} paid out (haircut ${(haircut * 100).toFixed(0)}%)`
      );
    } else {
      logs.push(
        `[INS-TRIGGER] ${market.eventId}: triggered but no coverage or insurer capital`
      );
    }

    // Reset capital + coverage; leave the user-key entries pruned (they
    // re-enter by posting fresh stakes).
    return {
      market: {
        ...market,
        insurerPositions: {},
        insurerCapital: 0,
        coverage: {},
        totalCoverage: 0,
        premiumRate: BASE_PREMIUM_RATE,
        cumulativeClaims:
          (market.cumulativeClaims ?? 0) +
          Object.values(claimIn).reduce((s, v) => s + v, 0),
        triggerCount: (market.triggerCount ?? 0) + 1,
        lastTickEpoch: currentEpoch,
      },
      premiumOut,
      premiumIn,
      claimOut,
      claimIn,
      logs,
    };
  }

  // No trigger: collect premium from insured, distribute to insurers.
  const rate = calcPremiumRate(market);
  let totalPremium = 0;

  for (const [uid, face] of Object.entries(market.coverage)) {
    const fee = face * rate;
    if (fee > 0) {
      premiumOut[uid] = (premiumOut[uid] ?? 0) + fee;
      totalPremium += fee;
    }
  }

  if (totalPremium > 0 && market.insurerCapital > 0) {
    for (const [uid, stake] of Object.entries(market.insurerPositions)) {
      const share = stake / market.insurerCapital;
      const earn = share * totalPremium;
      if (earn > 0) premiumIn[uid] = (premiumIn[uid] ?? 0) + earn;
    }
  }

  return {
    market: {
      ...market,
      premiumRate: rate,
      cumulativePremiums: (market.cumulativePremiums ?? 0) + totalPremium,
      lastTickEpoch: currentEpoch,
    },
    premiumOut,
    premiumIn,
    claimOut,
    claimIn,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Sum the user's insurer stakes across many markets.
export function totalInsurerStake(markets, userId) {
  let s = 0;
  for (const m of markets) s += m.insurerPositions?.[userId] ?? 0;
  return s;
}

// Sum the user's coverage across many markets.
export function totalCoverageHeld(markets, userId) {
  let s = 0;
  for (const m of markets) s += m.coverage?.[userId] ?? 0;
  return s;
}

// Maximum loss the user faces across all markets if every event triggers
// today. Caller uses this to gate solvency / TT mint constraints.
export function maxInsurerLossExposure(markets, userId) {
  let s = 0;
  for (const m of markets) {
    const stake = m.insurerPositions?.[userId] ?? 0;
    if (stake > 0 && m.totalCoverage > 0 && m.insurerCapital > 0) {
      const share = stake / m.insurerCapital;
      const haircut = Math.min(1, m.insurerCapital / m.totalCoverage);
      s += share * m.totalCoverage * haircut;
    }
  }
  return s;
}
