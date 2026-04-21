import { describe, it, expect } from "vitest";
import { calcYieldRouterSuggestions } from "../yieldRouter.js";
import { REGIMES } from "../regime.js";

describe("calcYieldRouterSuggestions", () => {
  const baseState = {
    normWeights: [0.25, 0.25, 0.25, 0.25],
    avgEntropyMult: 1,
    regime: { key: "CALM", ...REGIMES.CALM },
    realizedSigma: 0.02,
    currentYield: 0.03,
  };

  it("returns an array sorted by score desc", () => {
    const suggestions = calcYieldRouterSuggestions(
      { EURUSD: baseState, GBPUSD: baseState },
      [],
      0
    );
    expect(Array.isArray(suggestions)).toBe(true);
    for (let i = 1; i < suggestions.length; i++) {
      expect(suggestions[i - 1].score).toBeGreaterThanOrEqual(suggestions[i].score);
    }
  });

  it("marks REDUCE in CRASH regime", () => {
    const crashState = { ...baseState, regime: { key: "CRASH", ...REGIMES.CRASH } };
    const s = calcYieldRouterSuggestions({ BTC: crashState }, [], 0);
    expect(s[0].action).toBe("REDUCE");
  });

  it("marks OPEN_SHORT in TRENDING_DN regime", () => {
    const dn = { ...baseState, regime: { key: "TRENDING_DN", ...REGIMES.TRENDING_DN } };
    const s = calcYieldRouterSuggestions({ EURUSD: dn }, [], 0);
    expect(s[0].action).toBe("OPEN_SHORT");
  });

  it("credit score boosts score", () => {
    const low = calcYieldRouterSuggestions({ EURUSD: baseState }, [], 0);
    const high = calcYieldRouterSuggestions({ EURUSD: baseState }, [], 1);
    expect(high[0].score).toBeGreaterThan(low[0].score);
  });

  it("caps at 6 suggestions", () => {
    const states = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`PAIR${i}`, baseState])
    );
    const s = calcYieldRouterSuggestions(states, [], 0);
    expect(s.length).toBeLessThanOrEqual(6);
  });
});
