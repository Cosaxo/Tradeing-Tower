import { describe, it, expect } from "vitest";
import {
  assessCreditQualification,
  scorePortfolioComposition,
  calcConfigurationDrift,
  calcCreditRiskBudget,
  calcPairCreditEligibility,
} from "../credit.js";

describe("assessCreditQualification", () => {
  it("returns not-qualified for too-short history", () => {
    const r = assessCreditQualification([], [], {}, "EURUSD");
    expect(r.qualified).toBe(false);
    expect(r.creditScore).toBe(0);
  });

  it("scales with equity growth", () => {
    const bad = Array.from({ length: 15 }, (_, i) => ({
      users: [{ id: "You", margin: 5000 - i * 100 }],
    }));
    const good = Array.from({ length: 15 }, (_, i) => ({
      users: [{ id: "You", margin: 5000 + i * 100 }],
    }));
    const badR = assessCreditQualification(bad, [], {}, "EURUSD");
    const goodR = assessCreditQualification(good, [], {}, "EURUSD");
    expect(goodR.creditScore).toBeGreaterThan(badR.creditScore);
  });
});

describe("scorePortfolioComposition", () => {
  it("single uncorrelated position is mid-score", () => {
    const s = scorePortfolioComposition([{ pairKey: "EURUSD", side: "LONG" }], {});
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThanOrEqual(1);
  });

  it("hedge pair (long+short same pair) boosts score", () => {
    const base = scorePortfolioComposition([{ pairKey: "EURUSD", side: "LONG" }], {});
    const hedged = scorePortfolioComposition(
      [
        { pairKey: "EURUSD", side: "LONG" },
        { pairKey: "EURUSD", side: "SHORT" },
      ],
      {}
    );
    expect(hedged).toBeGreaterThan(base);
  });
});

describe("calcConfigurationDrift", () => {
  it("zero drift when positions unchanged", () => {
    const pos = [{ pairKey: "EURUSD", side: "LONG", leverage: 2 }];
    expect(calcConfigurationDrift(pos, pos)).toBe(0);
  });
  it("reports leverage drift", () => {
    const init = [{ pairKey: "EURUSD", side: "LONG", leverage: 2 }];
    const now = [{ pairKey: "EURUSD", side: "LONG", leverage: 5 }];
    expect(calcConfigurationDrift(now, init)).toBe(3);
  });
});

describe("calcCreditRiskBudget", () => {
  it("grows with credit score", () => {
    expect(calcCreditRiskBudget(1, 1000)).toBe(4000);
    expect(calcCreditRiskBudget(0, 1000)).toBe(1000);
  });
});

describe("calcPairCreditEligibility", () => {
  it("fails when score too low", () => {
    expect(calcPairCreditEligibility("EURUSD", 0.1, [], {}).eligible).toBe(false);
  });
  it("passes when score high and no correlation", () => {
    const e = calcPairCreditEligibility("EURUSD", 0.8, [], {});
    expect(e.eligible).toBe(true);
  });
});
