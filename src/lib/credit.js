// Skill-based credit system.
//
// Players earn credit extensions by demonstrating risk-adjusted performance
// over rolling windows. Four metrics contribute to a credit score:
//   - Sortino ratio  (downside-risk-adjusted return)
//   - Calmar ratio   (return / max drawdown)
//   - Max drawdown   (raw loss depth)
//   - Win rate       (fraction of profitable epochs)
//
// Plus a portfolio composition score that rewards diversification and
// penalises concentrated correlated books.

import {
  sortino,
  calcCalmar,
  calcWinRate,
  calcMaxDrawdown,
  calcReturns,
} from "./math.js";
import { portfolioCorrelationPenalty } from "./correlation.js";
import { getEffectiveCap } from "./esma.js";

const CREDIT_THRESHOLDS = {
  sortino: { poor: 0, fair: 0.5, good: 1.5, excellent: 3 },
  calmar: { poor: 0, fair: 0.2, good: 0.8, excellent: 2 },
  winRate: { poor: 0.3, fair: 0.45, good: 0.55, excellent: 0.65 },
  maxDD: { poor: 0.5, fair: 0.3, good: 0.15, excellent: 0.08 },
};

function scoreMetric(value, thresholds, higherIsBetter = true) {
  const { poor, fair, good, excellent } = thresholds;
  if (higherIsBetter) {
    if (value >= excellent) return 1;
    if (value >= good) return 0.75 + 0.25 * ((value - good) / (excellent - good));
    if (value >= fair) return 0.5 + 0.25 * ((value - fair) / (good - fair));
    if (value >= poor) return 0.25 + 0.25 * ((value - poor) / (fair - poor));
    return 0;
  } else {
    // Lower is better (maxDD).
    if (value <= excellent) return 1;
    if (value <= good) return 0.75 + 0.25 * ((good - value) / (good - excellent));
    if (value <= fair) return 0.5 + 0.25 * ((fair - value) / (fair - good));
    if (value <= poor) return 0.25 + 0.25 * ((poor - value) / (poor - fair));
    return 0;
  }
}

// Score portfolio composition: diversification, asset class spread, hedge pairs.
export function scorePortfolioComposition(openPositions, corrMap) {
  if (!openPositions || openPositions.length === 0) return 0.5;

  const pairs = openPositions.map((p) => p.pairKey);
  const corrPenalty = portfolioCorrelationPenalty(pairs, corrMap);

  // Diversity: more unique pairs → higher score (up to 4).
  const uniquePairs = new Set(pairs).size;
  const diversityScore = Math.min(1, uniquePairs / 4);

  // Hedge detection: long + short in same pair → bonus.
  const pairSides = {};
  openPositions.forEach((p) => {
    if (!pairSides[p.pairKey]) pairSides[p.pairKey] = new Set();
    pairSides[p.pairKey].add(p.side);
  });
  const hedgedPairs = Object.values(pairSides).filter((s) => s.size > 1).length;
  const hedgeBonus = Math.min(0.3, hedgedPairs * 0.15);

  const raw = diversityScore * (2 - corrPenalty / 2) + hedgeBonus;
  return Math.max(0, Math.min(1, raw));
}

// Assess credit qualification for the player.
// history: full epoch history array.
// Returns { creditScore [0-1], leverageExtension, qualified, breakdown }.
export function assessCreditQualification(history, openPositions, corrMap, pairKey) {
  if (!history || history.length < 10) {
    return { creditScore: 0, leverageExtension: 0, qualified: false, breakdown: {} };
  }

  const returns = calcReturns(history);
  const maxDD = calcMaxDrawdown(history);

  const sor = sortino(returns) ?? 0;
  const cal = calcCalmar(returns, maxDD) ?? 0;
  const wr = calcWinRate(returns) ?? 0.5;

  const sorScore = scoreMetric(Math.max(-1, Math.min(10, sor)), CREDIT_THRESHOLDS.sortino);
  const calScore = scoreMetric(Math.max(-1, Math.min(5, cal)), CREDIT_THRESHOLDS.calmar);
  const wrScore = scoreMetric(wr, CREDIT_THRESHOLDS.winRate);
  const ddScore = scoreMetric(maxDD, CREDIT_THRESHOLDS.maxDD, false);
  const compScore = scorePortfolioComposition(openPositions, corrMap);

  const creditScore = sorScore * 0.3 + calScore * 0.2 + wrScore * 0.2 + ddScore * 0.15 + compScore * 0.15;

  // Extension: up to 2× the ESMA cap for top performers.
  const { effectiveCap } = getEffectiveCap(pairKey ?? "EUR_USD", 0.01);
  const leverageExtension = effectiveCap * creditScore * 2;
  const qualified = creditScore > 0.6;

  return {
    creditScore: parseFloat(creditScore.toFixed(4)),
    leverageExtension: parseFloat(leverageExtension.toFixed(2)),
    qualified,
    breakdown: { sor: sorScore, cal: calScore, wr: wrScore, dd: ddScore, comp: compScore },
  };
}

// How much has the user drifted from their initial configuration?
// Measured as the average absolute change in leverage across open positions.
export function calcConfigurationDrift(currentPositions, initialPositions) {
  if (!initialPositions || initialPositions.length === 0) return 0;
  let drift = 0;
  currentPositions.forEach((pos) => {
    const init = initialPositions.find((p) => p.pairKey === pos.pairKey && p.side === pos.side);
    if (init) drift += Math.abs((pos.leverage ?? 1) - (init.leverage ?? 1));
  });
  return drift / Math.max(1, currentPositions.length);
}

// Risk budget: maximum total exposure permitted given current credit.
export function calcCreditRiskBudget(creditScore, baseMargin) {
  return baseMargin * (1 + creditScore * 3);
}

// Marginal risk contribution of one position to the portfolio.
export function calcCreditRiskContribution(position, totalExposure) {
  if (totalExposure <= 0) return 0;
  const posExposure = (position.margin ?? 0) * (position.leverage ?? 1);
  return posExposure / totalExposure;
}

// Whether a particular pair qualifies for credit-extended leverage.
export function calcPairCreditEligibility(pairKey, creditScore, openPositions, corrMap) {
  if (creditScore < 0.4) return { eligible: false, reason: "Credit score too low" };
  const openPairs = openPositions.map((p) => p.pairKey);
  const penalty = portfolioCorrelationPenalty([...openPairs, pairKey], corrMap);
  if (penalty > 1.7) {
    return { eligible: false, reason: "Portfolio too correlated" };
  }
  return { eligible: true, adjustedScore: creditScore / penalty };
}
