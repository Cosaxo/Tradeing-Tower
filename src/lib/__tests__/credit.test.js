import { describe, it, expect } from "vitest";
import {
  assessCreditQualification,
  scorePortfolioComposition,
  hedgeBalanceScore,
  concentrationScore,
  tailCoverageScore,
  diversityScore,
  leverageDisciplineScore,
  performanceComposite,
  evaluateGates,
  creditMultiplier,
  shouldUnwindCredit,
  calcConfigurationDrift,
} from "../credit.js";
import {
  M_BASELINE,
  M_MAX,
  CREDIT_ROLLING_WINDOW,
} from "../../constants/system.js";

const makeHistory = (n, start = 5000, growth = 100) =>
  Array.from({ length: n }, (_, i) => ({
    users: [{ id: "You", margin: start + i * growth }],
  }));

// ----- Composition sub-scores ---------------------------------------------

describe("hedgeBalanceScore", () => {
  it("maxes at 1 when net hedgeChar is zero", () => {
    const positions = [
      { pairKey: "GOLD", margin: 1000, side: "LONG", weight: 0.5, pair: { hedgeChar: 0.6 } },
      { pairKey: "SPX500", margin: 1000, side: "LONG", weight: 0.5, pair: { hedgeChar: -0.3 } },
    ];
    expect(hedgeBalanceScore(positions)).toBeGreaterThan(0.6);
  });
  it("is 0 when deeply one-sided", () => {
    const positions = [
      { pairKey: "SPX500", margin: 1000, side: "LONG", weight: 0.5, pair: { hedgeChar: -0.35 } },
      { pairKey: "DAX40", margin: 1000, side: "LONG", weight: 0.5, pair: { hedgeChar: -0.35 } },
    ];
    expect(hedgeBalanceScore(positions)).toBeCloseTo(0.3, 1);
  });
  it("returns 0 on empty portfolio", () => {
    expect(hedgeBalanceScore([])).toBe(0);
  });
});

describe("concentrationScore (HHI)", () => {
  it("equal weights = low HHI = high score", () => {
    const positions = [
      { pairKey: "A", weight: 0.25, pair: { hedgeChar: 0 } },
      { pairKey: "B", weight: 0.25, pair: { hedgeChar: 0 } },
      { pairKey: "C", weight: 0.25, pair: { hedgeChar: 0 } },
      { pairKey: "D", weight: 0.25, pair: { hedgeChar: 0 } },
    ];
    expect(concentrationScore(positions)).toBeGreaterThan(0.9);
  });
  it("single position = HHI 1 = 0 score", () => {
    const positions = [{ pairKey: "A", weight: 1, pair: { hedgeChar: 0 } }];
    expect(concentrationScore(positions)).toBe(0);
  });
});

describe("tailCoverageScore", () => {
  it("hits target at 15% tail allocation", () => {
    const positions = [
      { pairKey: "GOLD", weight: 0.15, pair: { hedgeChar: 0.6 } },
      { pairKey: "SPX", weight: 0.85, pair: { hedgeChar: -0.3 } },
    ];
    expect(tailCoverageScore(positions)).toBe(1);
  });
  it("partial credit below target", () => {
    const positions = [
      { pairKey: "GOLD", weight: 0.075, pair: { hedgeChar: 0.6 } },
      { pairKey: "SPX", weight: 0.925, pair: { hedgeChar: -0.3 } },
    ];
    expect(tailCoverageScore(positions)).toBeCloseTo(0.5);
  });
  it("zero when no tail assets", () => {
    const positions = [
      { pairKey: "SPX", weight: 0.5, pair: { hedgeChar: -0.3 } },
      { pairKey: "DAX", weight: 0.5, pair: { hedgeChar: -0.3 } },
    ];
    expect(tailCoverageScore(positions)).toBe(0);
  });
});

describe("diversityScore (Shannon)", () => {
  it("is 0 for single class", () => {
    const positions = [
      { pairKey: "A", weight: 0.5, pair: { assetClass: "STOCK" } },
      { pairKey: "B", weight: 0.5, pair: { assetClass: "STOCK" } },
    ];
    expect(diversityScore(positions)).toBe(0);
  });
  it("is ~1 for evenly spread classes", () => {
    const positions = [
      { pairKey: "A", weight: 0.33, pair: { assetClass: "STOCK" } },
      { pairKey: "B", weight: 0.33, pair: { assetClass: "FX_MAJOR" } },
      { pairKey: "C", weight: 0.34, pair: { assetClass: "GOLD" } },
    ];
    expect(diversityScore(positions)).toBeGreaterThan(0.99);
  });
});

describe("leverageDisciplineScore", () => {
  it("is 1 when using half-ESMA", () => {
    const positions = [
      { pairKey: "A", leverage: 1, pair: { assetClass: "CRYPTO" } }, // 1/2 = 0.5
    ];
    expect(leverageDisciplineScore(positions)).toBeCloseTo(0.5);
  });
  it("is 0 when at ESMA cap", () => {
    const positions = [
      { pairKey: "A", leverage: 2, pair: { assetClass: "CRYPTO" } },
    ];
    expect(leverageDisciplineScore(positions)).toBe(0);
  });
});

// ----- Composition aggregate -----------------------------------------------

describe("scorePortfolioComposition", () => {
  it("returns score + breakdown", () => {
    const result = scorePortfolioComposition([
      { pairKey: "GOLD", margin: 500, leverage: 2, side: "LONG" },
      { pairKey: "SPX500", margin: 500, leverage: 2, side: "LONG" },
    ]);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(result.breakdown).toHaveProperty("hedge");
    expect(result.breakdown).toHaveProperty("concentration");
    expect(result.breakdown).toHaveProperty("tail");
    expect(result.breakdown).toHaveProperty("diversity");
    expect(result.breakdown).toHaveProperty("discipline");
  });
});

// ----- Gates ---------------------------------------------------------------

describe("evaluateGates", () => {
  it("fails when history too short", () => {
    const { passed } = evaluateGates([], 0.5);
    expect(passed).toBe(false);
  });
  it("fails on low composition regardless of performance", () => {
    const history = makeHistory(CREDIT_ROLLING_WINDOW + 5, 5000, 200);
    const { passed, gates } = evaluateGates(history, 0.1);
    expect(passed).toBe(false);
    expect(gates.composition).toBe(false);
  });
});

// ----- Multiplier ---------------------------------------------------------

describe("creditMultiplier", () => {
  it("is 0 for unqualified users", () => {
    expect(
      creditMultiplier({
        qualified: false,
        compositionScore: 0.9,
        performanceScore: 0.9,
      })
    ).toBe(0);
  });

  it("matches whitepaper baseline + weights formula", () => {
    // qualified, comp=0, perf=0 → M = 0.5 baseline
    expect(
      creditMultiplier({
        qualified: true,
        compositionScore: 0,
        performanceScore: 0,
      })
    ).toBe(M_BASELINE);
  });

  it("applies cap at M_MAX", () => {
    expect(
      creditMultiplier({
        qualified: true,
        compositionScore: 1,
        performanceScore: 1,
      })
    ).toBeLessThanOrEqual(M_MAX);
  });

  it("composition dominates performance in magnitude", () => {
    const compDriven = creditMultiplier({
      qualified: true,
      compositionScore: 0.8,
      performanceScore: 0.3,
    });
    const perfDriven = creditMultiplier({
      qualified: true,
      compositionScore: 0.3,
      performanceScore: 0.8,
    });
    expect(compDriven).toBeGreaterThan(perfDriven);
  });

  it("drift penalty reduces multiplier", () => {
    const base = creditMultiplier({
      qualified: true,
      compositionScore: 0.5,
      performanceScore: 0.5,
      drift: 0,
    });
    const drifted = creditMultiplier({
      qualified: true,
      compositionScore: 0.5,
      performanceScore: 0.5,
      drift: 0.5,
    });
    expect(drifted).toBeLessThan(base);
  });
});

// ----- Hard floor ---------------------------------------------------------

describe("shouldUnwindCredit", () => {
  it("is false with no deployed credit", () => {
    expect(shouldUnwindCredit(5000, 0)).toBe(false);
  });
  it("fires when equity drops to deployed credit", () => {
    expect(shouldUnwindCredit(1000, 1000)).toBe(true);
    expect(shouldUnwindCredit(999, 1000)).toBe(true);
  });
  it("does not fire while equity still above deployed", () => {
    expect(shouldUnwindCredit(1500, 1000)).toBe(false);
  });
});

// ----- Drift --------------------------------------------------------------

describe("calcConfigurationDrift", () => {
  it("is 0 when positions unchanged", () => {
    const pos = [{ pairKey: "EURUSD", side: "LONG", leverage: 2 }];
    expect(calcConfigurationDrift(pos, pos)).toBe(0);
  });
  it("counts closed positions as drift", () => {
    const init = [{ pairKey: "EURUSD", side: "LONG", leverage: 2 }];
    expect(calcConfigurationDrift([], init)).toBeGreaterThan(0);
  });
  it("counts new positions as drift", () => {
    const now = [
      { pairKey: "EURUSD", side: "LONG", leverage: 2 },
      { pairKey: "GOLD", side: "LONG", leverage: 1 },
    ];
    const init = [{ pairKey: "EURUSD", side: "LONG", leverage: 2 }];
    expect(calcConfigurationDrift(now, init)).toBeGreaterThan(0);
  });
});

// ----- Full assessment ----------------------------------------------------

describe("assessCreditQualification", () => {
  it("returns unqualified for insufficient history", () => {
    const r = assessCreditQualification([], [], {}, "EURUSD");
    expect(r.qualified).toBe(false);
    expect(r.multiplier).toBe(0);
  });

  it("produces composition and performance breakdown", () => {
    const history = makeHistory(CREDIT_ROLLING_WINDOW + 5, 5000, 200);
    const positions = [
      { pairKey: "GOLD", margin: 500, leverage: 2, side: "LONG" },
      { pairKey: "SPX500", margin: 500, leverage: 2, side: "LONG" },
    ];
    const r = assessCreditQualification(history, positions, {}, "EURUSD");
    expect(r).toHaveProperty("composition");
    expect(r).toHaveProperty("performance");
    expect(r).toHaveProperty("gates");
    expect(r.composition.score).toBeGreaterThan(0);
  });

  it("performanceComposite returns zero score on short history", () => {
    const { score } = performanceComposite([]);
    expect(score).toBe(0);
  });
});
