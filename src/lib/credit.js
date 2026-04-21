// Credit Desk — whitepaper §7.4.
//
// Credit rewards how a portfolio is *built*, not how it recently performed.
//
// Performance metrics are BINARY GATES (all must pass). The multiplier
// magnitude is driven primarily by composition:
//
//   M = M_BASELINE + COMP_WEIGHT · s_comp · COMP_AMPLITUDE
//                  + PERF_WEIGHT · s_perf · PERF_AMPLITUDE,  capped at M_MAX
//
// Composition score (all sub-scores ∈ [0, 1]):
//
//   s_comp = W_HEDGE         · hedgeBalance
//          + W_CONCENTRATION · (0.6 − HHI)/0.35 clamped
//          + W_TAIL          · tailCoverage
//          + W_DIVERSITY     · shannon(weights_by_class)/log(n_classes)
//          + W_DISCIPLINE    · (1 − avg(L_i / L_ESMA,i))
//
// Drift detection (§7.4.4) now includes drift in the composition score
// itself, closing the loophole where a user qualifies, then sells off
// their tail hedges while keeping stated leverage identical.

import {
  sortino,
  calcCalmar,
  calcWinRate,
  calcMaxDrawdown,
  calcReturns,
} from "./math.js";
import { PAIRS, ASSET_CLASSES } from "../constants/assets.js";
import {
  CREDIT_GATE_SORTINO,
  CREDIT_GATE_CALMAR,
  CREDIT_GATE_MAX_DD,
  CREDIT_GATE_WIN_RATE,
  CREDIT_GATE_COMPOSITION,
  CREDIT_ROLLING_WINDOW,
  M_BASELINE,
  M_MAX,
  COMP_WEIGHT,
  PERF_WEIGHT,
  COMP_AMPLITUDE,
  PERF_AMPLITUDE,
  W_HEDGE,
  W_CONCENTRATION,
  W_TAIL,
  W_DIVERSITY,
  W_DISCIPLINE,
  TAIL_COVERAGE_TARGET,
  TAIL_HEDGE_THRESHOLD,
  CREDIT_DRIFT_THRESHOLD,
  CREDIT_DELEVERAGE_EPOCHS,
  CREDIT_DRIFT_HALF_LIFE,
  CREDIT_MIN_PERF_GATES,
  CREDIT_TOTAL_PERF_GATES,
} from "../constants/system.js";

// --------------------------------------------------------------------------
// Composition sub-scores
// --------------------------------------------------------------------------

// Capital weights per position, plus per-position metadata lookups.
function positionWeights(openPositions) {
  const total = openPositions.reduce((s, p) => s + (p.margin ?? 0), 0);
  if (total <= 0) return [];
  return openPositions.map((p) => ({
    ...p,
    weight: (p.margin ?? 0) / total,
    pair: PAIRS[p.pairKey],
  }));
}

// Hedge balance. `Σ w_i · h_i` close to zero means the book is neither
// net-long crisis response nor net-long equity-long. Score = max(0, 1 − 2|net|).
export function hedgeBalanceScore(weightedPositions) {
  if (weightedPositions.length === 0) return 0;
  const net = weightedPositions.reduce(
    (s, p) => s + p.weight * (p.pair?.hedgeChar ?? 0) * (p.side === "SHORT" ? -1 : 1),
    0
  );
  return Math.max(0, 1 - 2 * Math.abs(net));
}

// Herfindahl-Hirschman Index on per-pair capital share.
// Score = clamp((0.6 − HHI)/0.35, 0, 1). HHI of 0.6 or worse → 0; HHI of 0.25 or better → 1.
export function concentrationScore(weightedPositions) {
  if (weightedPositions.length === 0) return 0;
  // Aggregate by pair (handles long+short hedges on same pair as one position).
  const perPair = {};
  weightedPositions.forEach((p) => {
    perPair[p.pairKey] = (perPair[p.pairKey] ?? 0) + p.weight;
  });
  const hhi = Object.values(perPair).reduce((s, w) => s + w * w, 0);
  const raw = (0.6 - hhi) / 0.35;
  return Math.max(0, Math.min(1, raw));
}

// Tail coverage. Fraction of capital in assets with hedgeChar > TAIL_HEDGE_THRESHOLD,
// normalised against TAIL_COVERAGE_TARGET.
export function tailCoverageScore(weightedPositions) {
  if (weightedPositions.length === 0) return 0;
  const tailWeight = weightedPositions
    .filter((p) => (p.pair?.hedgeChar ?? 0) > TAIL_HEDGE_THRESHOLD)
    .reduce((s, p) => s + p.weight, 0);
  return Math.min(1, tailWeight / TAIL_COVERAGE_TARGET);
}

// Asset-class diversity — Shannon entropy normalised by log(n_classes_used).
export function diversityScore(weightedPositions) {
  if (weightedPositions.length === 0) return 0;
  const perClass = {};
  weightedPositions.forEach((p) => {
    const cls = p.pair?.assetClass ?? "UNKNOWN";
    perClass[cls] = (perClass[cls] ?? 0) + p.weight;
  });
  const n = Object.keys(perClass).length;
  if (n <= 1) return 0;
  const H = Object.values(perClass).reduce(
    (s, w) => (w > 0 ? s - w * Math.log(w) : s),
    0
  );
  return Math.min(1, H / Math.log(n));
}

// Leverage discipline — average leverage used vs ESMA cap; low is good.
export function leverageDisciplineScore(weightedPositions) {
  if (weightedPositions.length === 0) return 1; // no positions → maximum discipline
  const n = weightedPositions.length;
  const avgFraction = weightedPositions.reduce((s, p) => {
    const cls = ASSET_CLASSES[p.pair?.assetClass];
    const cap = cls?.esmaMaxLev ?? 2;
    return s + Math.min(1, (p.leverage ?? 1) / cap);
  }, 0) / n;
  return Math.max(0, 1 - avgFraction);
}

// Aggregate composition score ∈ [0, 1], per §7.4.2.
export function scorePortfolioComposition(openPositions /*, corrMap unused */) {
  const w = positionWeights(openPositions ?? []);
  const hedge = hedgeBalanceScore(w);
  const conc = concentrationScore(w);
  const tail = tailCoverageScore(w);
  const div = diversityScore(w);
  const disc = leverageDisciplineScore(w);

  return {
    score: parseFloat(
      (
        W_HEDGE * hedge +
        W_CONCENTRATION * conc +
        W_TAIL * tail +
        W_DIVERSITY * div +
        W_DISCIPLINE * disc
      ).toFixed(4)
    ),
    breakdown: { hedge, concentration: conc, tail, diversity: div, discipline: disc },
  };
}

// --------------------------------------------------------------------------
// Performance composite (§7.4.3). Gates are checked separately.
// --------------------------------------------------------------------------

function scaleToUnit(value, lo, hi) {
  if (hi === lo) return 0;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
}

// Metric-safe fallback: if a statistic is NaN/Infinity, substitute a sentinel.
// Using a sentinel instead of silently dropping the metric lets gate logic
// explicitly fail the check rather than let NaN short-circuit comparisons.
function finiteOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

export function performanceComposite(history) {
  if (!history || history.length < CREDIT_ROLLING_WINDOW) {
    return { score: 0, metrics: { sortino: 0, calmar: 0, winRate: 0.5, maxDD: 0 } };
  }
  const window = history.slice(-CREDIT_ROLLING_WINDOW);
  const returns = calcReturns(window);
  const maxDD = finiteOr(calcMaxDrawdown(window), 0);
  const sor = finiteOr(sortino(returns), 0);
  const cal = finiteOr(calcCalmar(returns, maxDD), 0);
  const wr = finiteOr(calcWinRate(returns), 0.5);

  // Scale each to [0, 1] over "just passed gate" → "clearly excellent".
  const sorScore = scaleToUnit(sor, CREDIT_GATE_SORTINO, 3.0);
  const calScore = scaleToUnit(cal, CREDIT_GATE_CALMAR, 2.0);
  const wrScore = scaleToUnit(wr, CREDIT_GATE_WIN_RATE, 0.65);
  const ddScore = scaleToUnit(CREDIT_GATE_MAX_DD - maxDD, 0, 0.1); // below-gate buffer

  return {
    score: (sorScore + calScore + wrScore + ddScore) / 4,
    metrics: { sortino: sor, calmar: cal, winRate: wr, maxDD },
  };
}

// --------------------------------------------------------------------------
// Binary gates
// --------------------------------------------------------------------------

export function evaluateGates(history, compositionScore) {
  if (!history || history.length < CREDIT_ROLLING_WINDOW) {
    return {
      passed: false,
      perfPassRatio: 0,
      gates: {
        sortino: false, calmar: false, maxDD: false,
        winRate: false, composition: false, window: false,
      },
    };
  }
  const window = history.slice(-CREDIT_ROLLING_WINDOW);
  const returns = calcReturns(window);
  const maxDD = finiteOr(calcMaxDrawdown(window), Infinity);
  const sor = finiteOr(sortino(returns), -Infinity);
  const cal = finiteOr(calcCalmar(returns, maxDD), -Infinity);
  const wr = finiteOr(calcWinRate(returns), 0);

  // Each gate compares against a well-defined threshold. Non-finite inputs
  // are mapped to the failing sentinel above, so any NaN in the raw metric
  // deterministically fails the gate rather than silently disqualifying on
  // a comparison with NaN.
  const gates = {
    window: true,
    sortino: sor >= CREDIT_GATE_SORTINO,
    calmar: cal >= CREDIT_GATE_CALMAR,
    maxDD: maxDD <= CREDIT_GATE_MAX_DD,
    winRate: wr >= CREDIT_GATE_WIN_RATE,
    composition: compositionScore >= CREDIT_GATE_COMPOSITION,
  };

  // Composition and window are hard requirements; the four perf gates
  // are graduated — the caller uses perfPassRatio to scale the multiplier.
  const perfPassed = [gates.sortino, gates.calmar, gates.maxDD, gates.winRate]
    .filter(Boolean).length;
  const perfPassRatio = perfPassed / CREDIT_TOTAL_PERF_GATES;
  const passed =
    gates.window &&
    gates.composition &&
    perfPassed >= CREDIT_MIN_PERF_GATES;

  return {
    passed,
    perfPassRatio,
    perfPassed,
    gates,
    measured: { sortino: sor, calmar: cal, maxDD, winRate: wr },
  };
}

// --------------------------------------------------------------------------
// Multiplier (§7.4.3)
// --------------------------------------------------------------------------

export function creditMultiplier({
  qualified,
  compositionScore,
  performanceScore,
  drift = 0,
  perfPassRatio = 1,
}) {
  if (!qualified) return 0;
  const raw =
    M_BASELINE +
    COMP_WEIGHT * compositionScore * COMP_AMPLITUDE +
    PERF_WEIGHT * performanceScore * PERF_AMPLITUDE;

  // Smoothly scale the perf contribution by how many perf gates cleared
  // (0.5 for the bare minimum, 1.0 for all four). Baseline + composition
  // are unaffected.
  const perfScale = Math.max(0.5, Math.min(1, perfPassRatio));
  const perfComponent = PERF_WEIGHT * performanceScore * PERF_AMPLITUDE;
  const scaled = raw - perfComponent + perfComponent * perfScale;

  // Drift penalty — up to 100% haircut when drift >= 1.
  const driftPenalty = 1 - Math.min(1, Math.max(0, drift));
  return Math.min(M_MAX, scaled * driftPenalty);
}

// --------------------------------------------------------------------------
// Top-level assessment
// --------------------------------------------------------------------------

// Whitepaper §7.4: credit rewards book construction primarily; performance
// is a binary sanity gate with marginal magnitude contribution.
export function assessCreditQualification(history, openPositions, corrMap, pairKey, initialPositions, currentEpoch) {
  const comp = scorePortfolioComposition(openPositions ?? []);
  const perf = performanceComposite(history);
  const gates = evaluateGates(history, comp.score);

  // Drift includes composition drift (§7.4.4) — selling tail hedges counts
  // even if leverage is unchanged. Positional drift decays exponentially
  // with position age (via openedAtEpoch + currentEpoch) so that rebalancing
  // isn't punished indefinitely.
  let drift = 0;
  if (initialPositions && initialPositions.length > 0) {
    const cfgDrift = calcConfigurationDrift(openPositions ?? [], initialPositions, {
      currentEpoch,
      halfLifeEpochs: CREDIT_DRIFT_HALF_LIFE,
    });
    const initComp = scorePortfolioComposition(initialPositions).score;
    const compDrift = Math.abs(comp.score - initComp);
    drift = Math.min(1, cfgDrift * 0.5 + compDrift * 2);
  }

  const multiplier = creditMultiplier({
    qualified: gates.passed,
    compositionScore: comp.score,
    performanceScore: perf.score,
    drift,
    perfPassRatio: gates.perfPassRatio,
  });

  // Deleverage schedule kicks in when drift >= threshold.
  const deleveraging = drift >= CREDIT_DRIFT_THRESHOLD;
  const deleverageEpochsRemaining = deleveraging ? CREDIT_DELEVERAGE_EPOCHS : 0;

  void corrMap; void pairKey; // reserved for future per-pair gating

  return {
    qualified: gates.passed,
    multiplier: parseFloat(multiplier.toFixed(4)),
    creditScore: parseFloat((multiplier / M_MAX).toFixed(4)), // legacy 0-1 for older UI
    leverageExtension: parseFloat((multiplier - 1).toFixed(4)), // M=1 is neutral
    drift: parseFloat(drift.toFixed(4)),
    deleveraging,
    deleverageEpochsRemaining,
    gates: gates.gates,
    perfPassRatio: gates.perfPassRatio,
    perfPassed: gates.perfPassed,
    measuredPerformance: gates.measured,
    composition: comp,
    performance: perf,
    breakdown: {
      ...comp.breakdown,
      perf: perf.score,
      drift,
    },
  };
}

// --------------------------------------------------------------------------
// Helpers retained from earlier API
// --------------------------------------------------------------------------

export function calcConfigurationDrift(currentPositions, initialPositions, opts = {}) {
  if (!initialPositions || initialPositions.length === 0) return 0;
  const { currentEpoch, halfLifeEpochs } = opts;

  // Decay factor for a position anchored at `openedAtEpoch`. Falls back to
  // no decay (weight=1) when either timestamp or half-life is unavailable,
  // preserving the original behavior for untagged positions.
  const decayWeight = (openedAtEpoch) => {
    if (
      !Number.isFinite(currentEpoch) ||
      !Number.isFinite(halfLifeEpochs) ||
      !Number.isFinite(openedAtEpoch) ||
      halfLifeEpochs <= 0
    ) {
      return 1;
    }
    const age = Math.max(0, currentEpoch - openedAtEpoch);
    return Math.pow(0.5, age / halfLifeEpochs);
  };

  let drift = 0;
  currentPositions.forEach((pos) => {
    const init = initialPositions.find(
      (p) => p.pairKey === pos.pairKey && p.side === pos.side
    );
    if (init) {
      drift += Math.abs((pos.leverage ?? 1) - (init.leverage ?? 1)) * decayWeight(init.openedAtEpoch);
    } else {
      drift += 0.5 * decayWeight(pos.openedAtEpoch);
    }
  });
  // Positions in initial but now closed also count — decay uses the
  // position's opening epoch so long-resolved trades don't linger.
  initialPositions.forEach((init) => {
    const still = currentPositions.find(
      (p) => p.pairKey === init.pairKey && p.side === init.side
    );
    if (!still) drift += 0.5 * decayWeight(init.openedAtEpoch);
  });
  return drift / Math.max(1, Math.max(currentPositions.length, initialPositions.length));
}

export function calcCreditRiskBudget(creditScore, baseMargin) {
  return baseMargin * (1 + creditScore * 3);
}

export function calcCreditRiskContribution(position, totalExposure) {
  if (totalExposure <= 0) return 0;
  const posExposure = (position.margin ?? 0) * (position.leverage ?? 1);
  return posExposure / totalExposure;
}

export function calcPairCreditEligibility(pairKey, creditScore, openPositions) {
  if (creditScore < 0.2) return { eligible: false, reason: "Credit score too low" };
  const openPairs = openPositions.map((p) => p.pairKey);
  if (openPairs.filter((p) => p === pairKey).length >= 2) {
    return { eligible: false, reason: "Already holds long+short on this pair" };
  }
  return { eligible: true, adjustedScore: creditScore };
}

// --------------------------------------------------------------------------
// Credit hard floor (§7.4.4): unwind if own equity falls to deployed credit.
// --------------------------------------------------------------------------

export function shouldUnwindCredit(ownEquity, deployedCredit) {
  if (deployedCredit <= 0) return false;
  return ownEquity <= deployedCredit;
}
