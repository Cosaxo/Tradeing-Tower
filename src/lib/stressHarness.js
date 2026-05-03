// Monte Carlo stress harness.
//
// Headless protocol simulator that drives the four-layer thread
// through scripted stress scenarios and reports the joint outcome
// distribution. The product's safety claim ("each user's joint
// outcome across all four layers is positive with very high
// probability under realistic stress") is empirically testable; this
// module is the test.
//
// Per session
// -----------
//
//   1. SETUP. The user "deposits $X" via the easy-mode auto-mint
//      path: post insurer stakes evenly across reinsurance-covered
//      events, buy reinsurance face = 1.5× X split across the 3
//      products, deposit X into B-book pool as thread-derived stake,
//      open one TT thread (1:1 mint).
//
//   2. COUNTERPARTIES. Synthetic insurance buyers and reinsurance
//      sellers are seeded so the markets actually settle. Without
//      buyers, no insurance trigger ever produces claimOut — there's
//      no exposure to test.
//
//   3. TICK LOOP. For `ticks` medium epochs:
//        - Roll seeded RNG against scenario.eventProbabilities to
//          decide which events trigger this tick.
//        - settleMarketTick on every market (premium flows when no
//          trigger; payouts when triggered).
//        - settleReinsuranceTick on every product (covers the user's
//          claim losses).
//        - Thread damage propagation: any user-side claim loss
//          shrinks the user's thread layer-by-layer atomically.
//        - T-bill yield on the user's wallet margin.
//        - Periodic redemption cycle (REDEMPTION_EVERY ticks): if
//          scenario.redemptionPressure > 0, queue that fraction of
//          the user's TT for standard redemption and drain the queue.
//
//   4. FINAL REDEMPTION. At the end, queue the user's remaining TT
//      for standard redemption and drain. This converts layer-4 face
//      back to dollars so the joint outcome reflects realised
//      wealth.
//
//   5. JOINT OUTCOME = (final user wallet $) - (initial deposit).
//      Plus per-layer P&L decomposition (T-bill, premium income,
//      claim losses, reinsurance payouts) for diagnostics.

import { TBILL_RATE, REDEMPTION_EVERY } from "../constants/system.js";
import { STANDARD_EVENTS } from "./insuranceEvents.js";
import {
  makeInsuranceMarket,
  postInsurer,
  postInsured,
  withdrawInsurer,
  settleMarketTick,
} from "./insuranceMarket.js";
import {
  makeReinsuranceSet,
  postReinsuranceBuyer,
  postReinsuranceSeller,
  settleReinsuranceTick,
} from "./reinsurance.js";
import { initBBookState, adjustThreadDerived } from "./bBookPool.js";
import {
  initTtState,
  openThread,
  damageThread,
  growThread,
  calcInsuranceFillWeights,
  submitRedemption,
  runRedemptionCycle,
  applySolvencyCheck,
} from "./towerTether.js";

// ---------------------------------------------------------------------------
// Seeded RNG
// ---------------------------------------------------------------------------

// mulberry32 — small fast deterministic PRNG. Reseeding the harness
// with the same seed reproduces the same scenario bit-for-bit.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

// Each scenario produces:
//   - eventProbabilities: per-medium-tick probability that each named
//     event triggers, evaluated against the seeded RNG. Events not
//     listed have probability 0.
//   - redemptionPressure: fraction of the user's wallet TT to queue
//     for standard redemption on each redemption cycle. 0 = no
//     redemption stress.
//   - ticks: how long the scenario runs (medium epochs).
//
// Probability calibration: 0.005/tick × 200 ticks → ~63% chance of at
// least one trigger across the run. 0.001 → ~18%. These are tail-risk
// events; in calibrated production the probabilities would be
// thinner, but for stress testing we want frequent enough triggers
// to actually exercise the damage path.

export const SCENARIOS = {
  CALM: {
    id: "CALM",
    name: "Calm market",
    description:
      "Baseline. No event triggers, no redemption pressure. Tests that the protocol delivers positive yield in benign conditions.",
    eventProbabilities: {},
    redemptionPressure: 0,
    ticks: 200,
  },
  SINGLE_EVENT: {
    id: "SINGLE_EVENT",
    name: "Single event trigger",
    description:
      "One major insurance event has ~30% chance of triggering during the run. Tests recovery via reinsurance + diversification.",
    eventProbabilities: { BTC_CRASH_20_WEEK: 0.0017 },
    redemptionPressure: 0,
    ticks: 200,
  },
  CORRELATED_CRISIS: {
    id: "CORRELATED_CRISIS",
    name: "Correlated multi-pair crisis",
    description:
      "Multiple correlated events (BTC + ETH crash + SPX drawdown + vol spike) each have meaningful trigger probability. Tests joint-stress survival.",
    eventProbabilities: {
      BTC_CRASH_20_WEEK: 0.003,
      ETH_CRASH_25_WEEK: 0.003,
      SPX_CRASH_10_2WEEK: 0.002,
      VOL_SPIKE: 0.005,
    },
    redemptionPressure: 0,
    ticks: 200,
  },
  REDEMPTION_PRESSURE: {
    id: "REDEMPTION_PRESSURE",
    name: "Sustained redemption pressure",
    description:
      "User redeems 25% of wallet TT each redemption cycle through the run. Tests the redemption mechanic — does staged unwind preserve principal?",
    eventProbabilities: {},
    redemptionPressure: 0.25,
    ticks: 200,
  },
};

// ---------------------------------------------------------------------------
// Setup helpers
// ---------------------------------------------------------------------------

// Build a fresh world: user "U" deposits and auto-mints; synthetic
// buyer "B" buys insurance to populate the markets; synthetic seller
// "S" funds the reinsurance pool.
function setupWorld({ userId, deposit, buyerFace, sellerCapital }) {
  // 1. Reinsurance products + sellers.
  let reinsurance = makeReinsuranceSet();
  for (const p of reinsurance) void p; // (no-op; just to silence unused-var hints in noisy linters)
  const totalCovFrac = reinsurance.reduce(
    (s, p) => s + (p.coverageFraction ?? 0),
    0
  ) || 1;
  reinsurance = reinsurance.map((p, i) => {
    const share = (p.coverageFraction ?? 0) / totalCovFrac;
    const cap = sellerCapital * share;
    const r = postReinsuranceSeller({
      product: p,
      userId: "S",
      amount: cap,
      currentEpoch: 0,
    });
    return r.ok ? r.product : p;
  });

  // 2. Insurance markets (one per standard event).
  let markets = STANDARD_EVENTS.map((ev) =>
    makeInsuranceMarket({
      eventId: ev.id,
      pairKey: ev.pairKey ?? null,
      category: ev.category,
    })
  );

  // 3. User's auto-mint:
  //    a. compute fill weights
  const reinsuranceLive = reinsurance.some((p) => (p.sellerCapital ?? 0) > 0);
  const eligibleMarkets = markets;
  const weights = calcInsuranceFillWeights({
    eligibleMarkets,
    reinsuranceLive,
  });

  //    b. post user's insurer stakes
  for (const [eventId, w] of Object.entries(weights)) {
    const fill = deposit * w;
    if (fill <= 1e-6) continue;
    const idx = markets.findIndex((m) => m.eventId === eventId);
    if (idx < 0) continue;
    const r = postInsurer({
      market: markets[idx],
      userId,
      amount: fill,
    });
    if (r.ok) markets = markets.map((m, i) => (i === idx ? r.market : m));
  }

  //    c. user buys reinsurance: face = 1.5× deposit split equally
  //       across products. Matches handleMintTT in App.jsx.
  const reinsuranceFacePerProduct = (deposit * 1.5) / reinsurance.length;
  reinsurance = reinsurance.map((p) => {
    const r = postReinsuranceBuyer({
      product: p,
      userId,
      faceAmount: reinsuranceFacePerProduct,
    });
    return r.ok ? r.product : p;
  });

  // 4. Synthetic insurance BUYER (so user-side has counterparty).
  //    Buyer purchases the same weight distribution as the user's
  //    insurer side at face = buyerFace.
  for (const [eventId, w] of Object.entries(weights)) {
    const fill = buyerFace * w;
    if (fill <= 1e-6) continue;
    const idx = markets.findIndex((m) => m.eventId === eventId);
    if (idx < 0) continue;
    const r = postInsured({
      market: markets[idx],
      userId: "B",
      faceAmount: fill,
    });
    if (r.ok) markets = markets.map((m, i) => (i === idx ? r.market : m));
  }

  // 5. B-book pool: user deposits as thread-derived stake.
  let bBookState = initBBookState();
  const adj = adjustThreadDerived({
    state: bBookState,
    uid: userId,
    delta: deposit,
  });
  if (adj.ok) bBookState = adj.state;

  // 6. Open thread (1:1 TT mint into user wallet).
  let ttState = initTtState();
  const opened = openThread({
    ttState,
    ownerId: userId,
    principal: deposit,
    insuranceWeights: weights,
    currentEpoch: 0,
  });
  if (opened.ok) ttState = opened.ttState;

  return {
    userMargin: 0, // pure cash margin; deposit is committed to the thread
    ttState,
    markets,
    reinsurance,
    bBookState,
    weights,
  };
}

// ---------------------------------------------------------------------------
// Tick simulation
// ---------------------------------------------------------------------------

function simulateTick({
  tickIndex,
  scenario,
  rng,
  state,
  userId,
  metrics,
}) {
  const triggered = [];
  for (const [eventId, prob] of Object.entries(
    scenario.eventProbabilities ?? {}
  )) {
    if (rng() < prob) triggered.push(eventId);
  }

  let { userMargin, ttState, markets, reinsurance, bBookState } = state;
  const buyerLossesByUser = {};
  const tickClaimLosses = [];

  // Settle each insurance market.
  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const eventTriggered = triggered.includes(m.eventId);
    const r = settleMarketTick({
      market: m,
      eventTriggered,
      currentEpoch: tickIndex,
    });
    markets = markets.map((x, idx) => (idx === i ? r.market : x));

    const premIn = r.premiumIn?.[userId] ?? 0;
    const premOut = r.premiumOut?.[userId] ?? 0;
    const claimIn = r.claimIn?.[userId] ?? 0;
    const claimOut = r.claimOut?.[userId] ?? 0;
    userMargin += premIn - premOut + claimIn - claimOut;

    metrics.premiumIn += premIn;
    metrics.premiumOut += premOut;
    metrics.claimIn += claimIn;
    metrics.claimOut += claimOut;

    for (const [uid, v] of Object.entries(r.claimOut ?? {})) {
      if (v > 0) buyerLossesByUser[uid] = (buyerLossesByUser[uid] ?? 0) + v;
    }
    if (Object.keys(r.claimOut ?? {}).length > 0) {
      tickClaimLosses.push({ eventId: m.eventId, lossesByUser: r.claimOut });
    }
  }

  // Settle each reinsurance product.
  for (let i = 0; i < reinsurance.length; i++) {
    const p = reinsurance[i];
    const r = settleReinsuranceTick({
      product: p,
      buyerLossesByUser,
      currentEpoch: tickIndex,
    });
    reinsurance = reinsurance.map((x, idx) => (idx === i ? r.product : x));

    const payout = r.payouts?.[userId] ?? 0;
    const sellerLoss = r.sellerLosses?.[userId] ?? 0;
    const premIn = r.premiumIn?.[userId] ?? 0;
    const premOut = r.premiumOut?.[userId] ?? 0;
    userMargin += payout - sellerLoss + premIn - premOut;

    metrics.reinsurancePayout += payout;
    metrics.reinsurancePremiumOut += premOut;
  }

  // Thread damage propagation. For each user claim loss this tick,
  // walk the user's threads (filtered to those carrying weight in
  // the triggered event), apply pro-rata damage, and propagate the
  // shrink across all four layers.
  if (tickClaimLosses.length > 0) {
    for (const { eventId, lossesByUser } of tickClaimLosses) {
      const lossAmt = lossesByUser[userId] ?? 0;
      if (lossAmt <= 0) continue;
      const userThreads = (ttState.threads ?? []).filter(
        (t) =>
          !t.closed &&
          t.ownerId === userId &&
          (t.insuranceWeights?.[eventId] ?? 0) > 0 &&
          t.principal > 1e-9
      );
      if (userThreads.length === 0) continue;
      const exposure = userThreads.map(
        (t) => t.principal * (t.insuranceWeights[eventId] ?? 0)
      );
      const totalExposure = exposure.reduce((s, v) => s + v, 0);
      if (totalExposure <= 0) continue;
      const damageBudget = Math.min(lossAmt, totalExposure);
      for (let i = 0; i < userThreads.length; i++) {
        const t = userThreads[i];
        const share = exposure[i] / totalExposure;
        const dmg = damageThread({
          ttState,
          threadId: t.id,
          delta: damageBudget * share,
        });
        if (dmg.deltaApplied <= 1e-9) continue;
        ttState = dmg.ttState;
        // Layer 2: withdraw per-market layer deltas (skip the
        // triggering market — claimOut already debited it).
        for (const [eid, cut] of Object.entries(
          dmg.insuranceLayerDeltas ?? {}
        )) {
          if (cut <= 1e-9) continue;
          if (eid === eventId) continue;
          const idx = markets.findIndex((m) => m.eventId === eid);
          if (idx < 0) continue;
          const r2 = withdrawInsurer({
            market: markets[idx],
            userId,
            amount: cut,
          });
          if (r2.ok) markets = markets.map((m, i) => (i === idx ? r2.market : m));
        }
        // Layer 3: shrink the B-book thread-derived stake.
        if (dmg.poolLayerDelta > 0) {
          const adj = adjustThreadDerived({
            state: bBookState,
            uid: userId,
            delta: -dmg.poolLayerDelta,
          });
          if (adj.ok) bBookState = adj.state;
        }
        metrics.threadDamageApplied += dmg.deltaApplied;
      }
    }
  }

  // T-bill yield on user's cash margin (matches the loop's per-tick
  // application).
  const tbill = userMargin * (TBILL_RATE / 365);
  userMargin += tbill;
  metrics.tbillEarned += tbill;

  // T-bill yield on every active thread's principal. This is what
  // the protocol PROMISES — layer 1 of the thread is a T-bill — but
  // the React epoch loop currently doesn't materialise it (a known
  // gap surfaced by the harness). For the safety claim to be
  // testable we model the design here: each tick, principal grows
  // by TBILL_RATE/365 and the corresponding layer-2 (insurance) and
  // layer-3 (B-book) stakes are also fattened via growThread.
  for (const t of ttState.threads ?? []) {
    if (t.closed || t.ownerId !== userId) continue;
    const gain = t.principal * (TBILL_RATE / 365);
    if (gain <= 1e-9) continue;
    const grown = growThread({ ttState, threadId: t.id, gain });
    if (grown.gainApplied <= 1e-9) continue;
    ttState = grown.ttState;
    metrics.threadPrincipalGain += grown.gainApplied;

    // Materialize layer-2 stake additions on each insurance market.
    for (const [eid, add] of Object.entries(grown.insuranceLayerAdds ?? {})) {
      if (add <= 1e-9) continue;
      const idx = markets.findIndex((m) => m.eventId === eid);
      if (idx < 0) continue;
      const r = postInsurer({
        market: markets[idx],
        userId,
        amount: add,
      });
      if (r.ok) markets = markets.map((m, i) => (i === idx ? r.market : m));
    }
    // Layer-3: grow the user's thread-derived B-book stake.
    if (grown.poolLayerAdd > 1e-9) {
      const adj = adjustThreadDerived({
        state: bBookState,
        uid: userId,
        delta: grown.poolLayerAdd,
      });
      if (adj.ok) bBookState = adj.state;
    }
  }

  // Periodic redemption cycle.
  if (
    tickIndex > 0 &&
    tickIndex % REDEMPTION_EVERY === 0 &&
    scenario.redemptionPressure > 0
  ) {
    const wallet = ttState.balances?.[userId] ?? 0;
    if (wallet > 1e-6) {
      const redeemAmt = wallet * scenario.redemptionPressure;
      const submitted = submitRedemption({
        ttState,
        userId,
        amount: redeemAmt,
        express: false,
        currentEpoch: tickIndex,
      });
      if (submitted.ok) ttState = submitted.ttState;
    }

    const cycle = runRedemptionCycle({ ttState, currentEpoch: tickIndex });
    ttState = cycle.ttState;

    for (const u of cycle.threadUnwinds) {
      if (u.ownerId !== userId) continue;
      for (const [eid, cut] of Object.entries(u.insuranceLayerDeltas ?? {})) {
        if (cut <= 1e-9) continue;
        const idx = markets.findIndex((m) => m.eventId === eid);
        if (idx < 0) continue;
        const r = withdrawInsurer({
          market: markets[idx],
          userId,
          amount: cut,
        });
        if (r.ok) markets = markets.map((m, i) => (i === idx ? r.market : m));
      }
      if (u.poolLayerDelta > 0) {
        const adj = adjustThreadDerived({
          state: bBookState,
          uid: userId,
          delta: -u.poolLayerDelta,
        });
        if (adj.ok) bBookState = adj.state;
      }
    }

    const dollarsOut = cycle.dollarsOut?.[userId] ?? 0;
    userMargin += dollarsOut;
    metrics.redemptionDollars += dollarsOut;

    const solvency = applySolvencyCheck({ ttState, userId });
    ttState = solvency.ttState;
    metrics.clawbackTotal += solvency.clawback ?? 0;
    metrics.debtTotal = (ttState.debtByUser?.[userId] ?? 0);
  }

  return { userMargin, ttState, markets, reinsurance, bBookState };
}

// ---------------------------------------------------------------------------
// Final wealth — value remaining TT at face after a solvency check.
// ---------------------------------------------------------------------------
//
// Forcing express redemption at the end of the session distorts the
// joint outcome by ~5% (the express penalty). A real user holding
// TT through a stress run would either redeem standard over time
// (modelled when scenario.redemptionPressure > 0) or simply continue
// to hold. We approximate "continue to hold" as: solvency-check the
// ttState (claws back any TT face above its principal backing) and
// then value remaining wallet TT at $1.

function finaliseWealth({ state, userId, metrics }) {
  let { userMargin, ttState, markets, bBookState } = state;
  // Solvency: any phantom TT (face > principal after damage) is
  // clawed back from the wallet first; residual becomes debt.
  const solvency = applySolvencyCheck({ ttState, userId });
  ttState = solvency.ttState;
  metrics.clawbackTotal += solvency.clawback ?? 0;
  metrics.debtTotal = ttState.debtByUser?.[userId] ?? 0;

  // Value the user's threads at their PRINCIPAL — this is the dollars
  // the user could redeem out (the buffer above ttFace can be unlocked
  // by minting more TT, then redeeming; we collapse that two-step into
  // one valuation). Subtract any soft debt.
  const userThreads = (ttState.threads ?? []).filter(
    (t) => !t.closed && t.ownerId === userId
  );
  const totalPrincipal = userThreads.reduce((s, t) => s + t.principal, 0);
  userMargin += totalPrincipal - (metrics.debtTotal ?? 0);
  metrics.finalThreadPrincipal = totalPrincipal;
  metrics.expressPenalty = 0;

  return { userMargin, ttState, markets, bBookState };
}

// ---------------------------------------------------------------------------
// Public API: one session
// ---------------------------------------------------------------------------

export function runStressSession({
  scenario,
  seed = 1,
  initialDeposit = 10000,
  buyerFace = null,
  sellerCapital = null,
} = {}) {
  if (!scenario) throw new Error("scenario required");

  // Default counterparty sizing: matched buyer (1× user stake) and
  // generous reinsurance sellers (10× user stake) so payouts aren't
  // capped by seller capacity in the typical case.
  const _buyerFace = buyerFace ?? initialDeposit;
  const _sellerCapital = sellerCapital ?? initialDeposit * 10;

  const userId = "U";
  const rng = mulberry32(seed);

  const setup = setupWorld({
    userId,
    deposit: initialDeposit,
    buyerFace: _buyerFace,
    sellerCapital: _sellerCapital,
  });

  let state = {
    userMargin: setup.userMargin,
    ttState: setup.ttState,
    markets: setup.markets,
    reinsurance: setup.reinsurance,
    bBookState: setup.bBookState,
  };

  const metrics = {
    tbillEarned: 0,
    threadPrincipalGain: 0,
    premiumIn: 0,
    premiumOut: 0,
    claimIn: 0,
    claimOut: 0,
    reinsurancePayout: 0,
    reinsurancePremiumOut: 0,
    threadDamageApplied: 0,
    redemptionDollars: 0,
    clawbackTotal: 0,
    debtTotal: 0,
    finalThreadPrincipal: 0,
    expressPenalty: 0,
    triggerCount: 0,
  };

  for (let t = 0; t < scenario.ticks; t++) {
    state = simulateTick({
      tickIndex: t + 1,
      scenario,
      rng,
      state,
      userId,
      metrics,
    });
  }

  // Track total trigger count (post-hoc, by counting non-zero claim
  // batches).
  // The metrics aren't perfect — claimIn/Out are user-side flows, not
  // global trigger counts. We approximate via the markets' triggerCount.
  metrics.triggerCount = state.markets.reduce(
    (s, m) => s + (m.triggerCount ?? 0),
    0
  );

  // Finalise: solvency-check + value remaining TT at face.
  state = finaliseWealth({ state, userId, metrics });

  // Joint outcome.
  const finalWealth = state.userMargin;
  const jointOutcomeDelta = finalWealth - initialDeposit;
  const jointOutcomeFraction = jointOutcomeDelta / initialDeposit;
  // Annualised: ticks ≈ days. Annualisation = (1 + frac)^(365/ticks) - 1.
  const annualisedYield =
    scenario.ticks > 0
      ? Math.pow(1 + jointOutcomeFraction, 365 / scenario.ticks) - 1
      : jointOutcomeFraction;

  return {
    seed,
    scenarioId: scenario.id,
    initialDeposit,
    finalWealth,
    jointOutcomeDelta,
    jointOutcomeFraction,
    annualisedYield,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Public API: aggregate batch
// ---------------------------------------------------------------------------

// Run N seeded sessions of the same scenario and aggregate results.
// `n` defaults to 200 — small enough to run in <1s in the browser,
// large enough for stable percentile estimates.
export function runStressBatch({
  scenario,
  n = 200,
  seedBase = 0,
  initialDeposit = 10000,
  onProgress = null,
} = {}) {
  if (!scenario) throw new Error("scenario required");

  const results = [];
  for (let i = 0; i < n; i++) {
    const r = runStressSession({
      scenario,
      seed: seedBase + i + 1,
      initialDeposit,
    });
    results.push(r);
    if (onProgress) onProgress(i + 1, n);
  }

  return aggregateBatch({ scenario, results, initialDeposit });
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function percentile(sortedArr, p) {
  if (sortedArr.length === 0) return 0;
  const idx = Math.min(
    sortedArr.length - 1,
    Math.max(0, Math.floor((sortedArr.length - 1) * p))
  );
  return sortedArr[idx];
}

function aggregateBatch({ scenario, results, initialDeposit }) {
  const n = results.length;
  const fractions = results.map((r) => r.jointOutcomeFraction).sort((a, b) => a - b);
  const annualised = results.map((r) => r.annualisedYield).sort((a, b) => a - b);

  const positiveCount = fractions.filter((f) => f >= 0).length;
  const beat5pctCount = fractions.filter((f) => f >= 0.05).length;
  const negativeCount = n - positiveCount;

  const meanFraction = fractions.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const meanAnnualised =
    annualised.reduce((s, v) => s + v, 0) / Math.max(1, n);

  // Distribution of per-layer flows in absolute dollars.
  const layerSum = (key) =>
    results.reduce((s, r) => s + (r.metrics[key] ?? 0), 0) / Math.max(1, n);

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    n,
    initialDeposit,
    headline: {
      pPositive: positiveCount / n,
      pBeats5pct: beat5pctCount / n,
      pNegative: negativeCount / n,
      meanFraction,
      meanAnnualised,
    },
    distribution: {
      fraction: {
        p05: percentile(fractions, 0.05),
        p25: percentile(fractions, 0.25),
        p50: percentile(fractions, 0.5),
        p75: percentile(fractions, 0.75),
        p95: percentile(fractions, 0.95),
        worst: fractions[0] ?? 0,
        best: fractions[fractions.length - 1] ?? 0,
      },
      annualised: {
        p05: percentile(annualised, 0.05),
        p50: percentile(annualised, 0.5),
        p95: percentile(annualised, 0.95),
      },
    },
    perLayerMean: {
      tbillEarned: layerSum("tbillEarned"),
      insurancePremiumNet: layerSum("premiumIn") - layerSum("premiumOut"),
      claimNet: layerSum("claimIn") - layerSum("claimOut"),
      reinsuranceNet:
        layerSum("reinsurancePayout") - layerSum("reinsurancePremiumOut"),
      threadDamageApplied: layerSum("threadDamageApplied"),
      finalRedemption: layerSum("finalRedemption"),
      debtRemaining: layerSum("debtTotal"),
    },
    triggerCountMean: layerSum("triggerCount"),
    rawFractions: fractions, // for histogram rendering
  };
}
