// Focused Monte-Carlo harness for the Tier-3 LAP pool's passive-LP role.
//
// What it answers
// ---------------
// Under what kind of order-flow imbalance and stability-fee revenue does
// passive LP-ing the LAP pool produce a positive yield, and how
// bounded is the directional risk?
//
// What it does NOT model
// ----------------------
// Insurance, reinsurance, redemption pressure, B-book — those are
// covered by stressHarness.js. This file is a single-layer probe of
// the LAP pool's economics in isolation, so the yield number is
// attributable only to the pool's mechanics, not to the rest of the
// thread.
//
// Per session
// -----------
// 1. SETUP. Underwriter "U" deposits `initialDeposit` into the LAP
//    pool as voluntary stake.
// 2. TICK LOOP. Each tick:
//    a. Generate `bidsPerTick` synthetic unmatched bids (skewed long
//       or short by `imbalanceSide`). Each bid has margin drawn from a
//       lognormal distribution and a leverage from a small set.
//    b. Compute a stability-fee budget for the tick:
//          budget = (sum of bid margins) × feeRateOnBidMargin
//                   × LAP_POOL_REBATE_FEE_SHARE
//       Calibration: in production stabilityFeeCollected is a per-tick
//       fee on MATCHED flow which dwarfs the unmatched flow. Here we
//       roll the matched-flow multiplier into feeRateOnBidMargin so
//       the budget is expressed in terms of the bids the pool actually
//       sees. To fully fund a 2% tip rate, feeRateOnBidMargin must be
//       at least ~0.029 (2% / LAP_POOL_REBATE_FEE_SHARE).
//    c. absorbImbalance with that budget; distributeRebate.
//    d. Apply a small Gaussian price walk (so aged-out closes produce
//       real P&L).
//    e. maintainAbsorbed at LAP_POOL_HOLD_EPOCHS.
// 3. FINALISE. Compute joint outcome = (final voluntary stake) -
//    (initial deposit). Annualise.

import {
  initLapPoolState,
  depositUnderwriter,
  absorbImbalance,
  distributeRebate,
  maintainAbsorbed,
  voluntaryStakeOf,
} from "./lapPool.js";
import {
  LAP_POOL_HOLD_EPOCHS,
  LAP_POOL_REBATE_FEE_SHARE,
} from "../constants/system.js";

// ---------------------------------------------------------------------------
// Seeded RNG (mirrors stressHarness.js)
// ---------------------------------------------------------------------------

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

function gaussian(rng) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

export const LAP_POOL_SCENARIOS = {
  STEADY_IMBALANCE: {
    id: "STEADY_IMBALANCE",
    name: "Steady mild imbalance",
    description:
      "3 unmatched longs/tick, fee budget covers ~all funded tips. Models a market where retail flow is consistently long-biased and the protocol's stability-fee revenue is sufficient to fund rebates.",
    bidsPerTick: 3,
    imbalanceSide: "LONG",
    feeRateOnBidMargin: 0.04,
    sigmaPerTick: 0.005,
    ticks: 200,
  },
  HIGH_IMBALANCE: {
    id: "HIGH_IMBALANCE",
    name: "Sustained heavy imbalance",
    description:
      "8 unmatched longs/tick, generous fee budget. Models the favourable case for passive LP — lots of imbalance, lots of fee revenue to fund rebates.",
    bidsPerTick: 8,
    imbalanceSide: "LONG",
    feeRateOnBidMargin: 0.05,
    sigmaPerTick: 0.005,
    ticks: 200,
  },
  ALTERNATING_IMBALANCE: {
    id: "ALTERNATING_IMBALANCE",
    name: "Alternating imbalance side",
    description:
      "Imbalance flips between long-biased and short-biased every 20 ticks. Tests that the pool earns symmetrically and that age-out closes don't bias outcomes.",
    bidsPerTick: 4,
    imbalanceSide: "ALTERNATING",
    feeRateOnBidMargin: 0.04,
    sigmaPerTick: 0.005,
    ticks: 200,
  },
  THIN_FEE_BUDGET: {
    id: "THIN_FEE_BUDGET",
    name: "Thin fee budget",
    description:
      "Strong imbalance but the protocol's stability-fee rate is below tip cost — most rebate is throttled by the budget cap. Tests that throttling preserves conservation: pool stake doesn't drift even when the requested rebate vastly exceeds funded.",
    bidsPerTick: 5,
    imbalanceSide: "LONG",
    feeRateOnBidMargin: 0.01,
    sigmaPerTick: 0.005,
    ticks: 200,
  },
  VOLATILE_PRICE: {
    id: "VOLATILE_PRICE",
    name: "Volatile price walk",
    description:
      "Steady imbalance but prices walk hard (3× normal sigma). Aged-out closes produce big directional P&L — tests that the pool's realised P&L distribution stays bounded.",
    bidsPerTick: 3,
    imbalanceSide: "LONG",
    feeRateOnBidMargin: 0.04,
    sigmaPerTick: 0.015,
    ticks: 200,
  },
  INFORMED_FLOW: {
    id: "INFORMED_FLOW",
    name: "Informed minority-side flow",
    description:
      "Half the per-tick bids come from INFORMED traders with k-tick price foresight: they pick the side that will profit from the upcoming move, and the unmatched flow lands on that winning side. WITHOUT the classifier filter, the pool absorbs them and bleeds (it's structurally on the losing side). WITH the filter (A-classified bids excluded), the pool only takes uninformed retail flow and stays close to neutral. Empirical validation of the filter's value.",
    bidsPerTick: 4,
    imbalanceSide: "INFORMED",       // dynamic per tick — picks the winning side
    feeRateOnBidMargin: 0.04,
    sigmaPerTick: 0.008,             // a bit higher so look-ahead bidders find real moves
    informedBidsPerTick: 2,          // 2 of the 4 are informed (50%)
    informedLookahead: 5,            // peek 5 ticks ahead
    ticks: 200,
  },
};

// ---------------------------------------------------------------------------
// Bid generation
// ---------------------------------------------------------------------------

const LEVERAGE_OPTIONS = [1, 2, 3, 5];

function makeSyntheticBid({ rng, side, idx, tickIndex, prefix = null }) {
  // Lognormal margin: median ~$1000, std ~$500.
  const margin = Math.exp(6.7 + 0.5 * gaussian(rng));
  const leverage =
    LEVERAGE_OPTIONS[Math.min(LEVERAGE_OPTIONS.length - 1, Math.floor(rng() * LEVERAGE_OPTIONS.length))];
  // Prefix lets the harness encode informed-vs-retail in the user id so
  // the classifier filter can separate them downstream.
  const idPrefix = prefix ?? side;
  return {
    id: `${idPrefix}-${tickIndex}-${idx}`,
    base_margin: Math.max(50, margin), // floor at $50 so MIN_FILL_LEVERAGE doesn't rule everyone out
    max_lev: leverage,
    tip_tiers: [{ tip: 0.02 }],
    activePair: "BTCUSD",
  };
}

// ---------------------------------------------------------------------------
// One session
// ---------------------------------------------------------------------------

export function runLapPoolYieldSession({
  scenario,
  seed = 1,
  initialDeposit = 10_000,
  // INFORMED_FLOW only: when true, A-classified informed bidders are
  // filtered out at absorbImbalance via classifierState. When false,
  // the pool absorbs everyone — the baseline against which the filter
  // is empirically validated.
  useClassifierFilter = false,
} = {}) {
  if (!scenario) throw new Error("scenario required");

  const usingInformed = (scenario.informedBidsPerTick ?? 0) > 0;

  // For informed-flow scenarios the price walk is precomputed up front
  // so informed bidders can read it (foresight). RNG streams are
  // separated: walk seed = `seed`, bid-generation seed = `seed + 17`.
  // For other scenarios the original tick-by-tick walk is preserved
  // (one combined RNG, unchanged from previous behavior).
  let priceWalk = null;
  let rng;
  if (usingInformed) {
    const walkRng = mulberry32(seed);
    const length = scenario.ticks + (scenario.informedLookahead ?? 1) + 2;
    priceWalk = [100];
    for (let i = 0; i < length; i++) {
      priceWalk.push(
        priceWalk[priceWalk.length - 1] * Math.exp(scenario.sigmaPerTick * gaussian(walkRng))
      );
    }
    rng = mulberry32(seed + 17);
  } else {
    rng = mulberry32(seed);
  }

  // Synthetic classifier state — only built when the filter is requested
  // and the scenario has informed bidders. Marks `INFORMED-*` user ids
  // as A-classified; everyone else (RETAIL-*, side-prefixed) defaults to
  // B in routeFor.
  let classifierState = null;
  if (useClassifierFilter && usingInformed) {
    classifierState = { byUser: {} };
    for (let t = 1; t <= scenario.ticks; t++) {
      for (let i = 0; i < (scenario.informedBidsPerTick ?? 0); i++) {
        classifierState.byUser[`INFORMED-${t}-${i}`] = {
          closedPositions: new Array(20).fill({}),
          currentClass: "A",
          avgMargin: 1000,
        };
      }
    }
  }

  const userId = "U";
  let state = initLapPoolState();
  state = depositUnderwriter({
    state,
    uid: userId,
    amount: initialDeposit,
    currentEpoch: 0,
  }).state;

  let price = priceWalk ? priceWalk[0] : 100;
  const metrics = {
    rebateFunded: 0,
    rebateRequested: 0,
    realizedPnl: 0,
    contractsAbsorbed: 0,
    contractsClosed: 0,
    maxActiveAbsorbed: 0,
    informedAbsorbed: 0, // count of INFORMED-* contracts that landed on the pool
    retailAbsorbed: 0,
  };

  const flipBlock = 20;

  for (let t = 1; t <= scenario.ticks; t++) {
    // Side selection.
    let side;
    if (scenario.imbalanceSide === "ALTERNATING") {
      side = Math.floor(t / flipBlock) % 2 === 0 ? "LONG" : "SHORT";
    } else if (scenario.imbalanceSide === "INFORMED") {
      // Informed flow: pick the side that profits from the next look-ahead window.
      const priceNow = priceWalk[t];
      const priceFuture = priceWalk[t + (scenario.informedLookahead ?? 1)];
      side = priceFuture > priceNow ? "LONG" : "SHORT";
    } else {
      side = scenario.imbalanceSide;
    }

    // Generate bids — split between informed and retail when applicable.
    const informedCount = scenario.informedBidsPerTick ?? 0;
    const retailCount = Math.max(0, scenario.bidsPerTick - informedCount);
    const bids = [];
    for (let i = 0; i < informedCount; i++) {
      bids.push(makeSyntheticBid({ rng, side, idx: i, tickIndex: t, prefix: "INFORMED" }));
    }
    for (let i = 0; i < retailCount; i++) {
      bids.push(makeSyntheticBid({ rng, side, idx: i, tickIndex: t, prefix: "RETAIL" }));
    }

    const totalMargin = bids.reduce((s, b) => s + b.base_margin, 0);
    const rebateBudget =
      totalMargin * scenario.feeRateOnBidMargin * LAP_POOL_REBATE_FEE_SHARE;

    const absorb = absorbImbalance({
      state,
      unmatchedLongs: side === "LONG" ? bids : [],
      unmatchedShorts: side === "SHORT" ? bids : [],
      normWeights: [1, 1, 1, 1],
      bucketLevs: LEVERAGE_OPTIONS,
      openPrice: price,
      currentEpoch: t,
      rebateBudget,
      classifierState,
    });
    state = absorb.state;
    metrics.rebateFunded += absorb.totalRebate;
    metrics.rebateRequested += absorb.rebateRequested;
    metrics.contractsAbsorbed += absorb.absorbedContracts.length;
    for (const c of absorb.absorbedContracts) {
      if ((c.absorbedUserId ?? "").startsWith("INFORMED-")) metrics.informedAbsorbed += 1;
      else metrics.retailAbsorbed += 1;
    }

    if (absorb.totalRebate > 0) {
      state = distributeRebate({ state, totalRebate: absorb.totalRebate }).state;
    }

    // Advance price. Informed scenarios read from the precomputed walk;
    // others continue the original tick-by-tick random walk.
    if (priceWalk) {
      price = priceWalk[t];
    } else {
      price *= Math.exp(scenario.sigmaPerTick * gaussian(rng));
    }

    // Per-tick maintenance: close aged contracts.
    const maint = maintainAbsorbed({
      state,
      pricesByPair: { BTCUSD: price },
      currentEpoch: t,
      maxHoldEpochs: LAP_POOL_HOLD_EPOCHS,
    });
    state = maint.state;
    metrics.realizedPnl += maint.totalRealizedPnl;
    metrics.contractsClosed += maint.closed.length;
    metrics.maxActiveAbsorbed = Math.max(
      metrics.maxActiveAbsorbed,
      state.activeAbsorbed.length
    );
  }

  // Final wealth: close all remaining contracts at terminal price (so the
  // outcome reflects realised state, not unrealised).
  if (state.activeAbsorbed.length > 0) {
    const finalMaint = maintainAbsorbed({
      state,
      pricesByPair: { BTCUSD: price },
      currentEpoch: scenario.ticks + 1e6, // force aging
      maxHoldEpochs: 0,
    });
    state = finalMaint.state;
    metrics.realizedPnl += finalMaint.totalRealizedPnl;
    metrics.contractsClosed += finalMaint.closed.length;
  }

  const finalStake = voluntaryStakeOf(state, userId);
  const jointOutcomeDelta = finalStake - initialDeposit;
  const jointOutcomeFraction = jointOutcomeDelta / initialDeposit;
  const annualisedYield =
    scenario.ticks > 0
      ? Math.pow(1 + jointOutcomeFraction, 365 / scenario.ticks) - 1
      : jointOutcomeFraction;

  return {
    seed,
    scenarioId: scenario.id,
    initialDeposit,
    finalStake,
    jointOutcomeDelta,
    jointOutcomeFraction,
    annualisedYield,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Aggregate batch
// ---------------------------------------------------------------------------

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor((sorted.length - 1) * p))
  );
  return sorted[idx];
}

export function runLapPoolYieldBatch({
  scenario,
  n = 200,
  seedBase = 0,
  initialDeposit = 10_000,
  useClassifierFilter = false,
} = {}) {
  if (!scenario) throw new Error("scenario required");
  const results = [];
  for (let i = 0; i < n; i++) {
    results.push(
      runLapPoolYieldSession({
        scenario,
        seed: seedBase + i + 1,
        initialDeposit,
        useClassifierFilter,
      })
    );
  }
  const fractions = results.map((r) => r.jointOutcomeFraction).sort((a, b) => a - b);
  const annualised = results.map((r) => r.annualisedYield).sort((a, b) => a - b);
  const positiveCount = fractions.filter((f) => f >= 0).length;
  const meanFraction = fractions.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const meanAnnualised = annualised.reduce((s, v) => s + v, 0) / Math.max(1, n);
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    n,
    initialDeposit,
    headline: {
      pPositive: positiveCount / n,
      meanFraction,
      meanAnnualised,
    },
    distribution: {
      fraction: {
        p05: percentile(fractions, 0.05),
        p50: percentile(fractions, 0.5),
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
    metricsMean: {
      rebateFunded:
        results.reduce((s, r) => s + r.metrics.rebateFunded, 0) / Math.max(1, n),
      rebateRequested:
        results.reduce((s, r) => s + r.metrics.rebateRequested, 0) / Math.max(1, n),
      realizedPnl:
        results.reduce((s, r) => s + r.metrics.realizedPnl, 0) / Math.max(1, n),
      contractsAbsorbed:
        results.reduce((s, r) => s + r.metrics.contractsAbsorbed, 0) /
        Math.max(1, n),
      contractsClosed:
        results.reduce((s, r) => s + r.metrics.contractsClosed, 0) /
        Math.max(1, n),
      maxActiveAbsorbed:
        results.reduce((s, r) => s + r.metrics.maxActiveAbsorbed, 0) /
        Math.max(1, n),
      informedAbsorbed:
        results.reduce((s, r) => s + (r.metrics.informedAbsorbed ?? 0), 0) /
        Math.max(1, n),
      retailAbsorbed:
        results.reduce((s, r) => s + (r.metrics.retailAbsorbed ?? 0), 0) /
        Math.max(1, n),
    },
    rawFractions: fractions,
  };
}
