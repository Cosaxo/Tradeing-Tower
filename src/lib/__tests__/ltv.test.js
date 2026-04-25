import { describe, it, expect } from "vitest";
import {
  calcPoolLtv,
  calcAvailablePoolCredit,
  isOverCreditBudget,
  POOL_LTV_FLOOR,
  POOL_LTV_CEILING,
} from "../ltv.js";

describe("calcPoolLtv", () => {
  it("returns the floor for an empty book — untested diversification", () => {
    const { ltv } = calcPoolLtv([]);
    expect(ltv).toBe(POOL_LTV_FLOOR);
  });

  it("stays near the floor for a single concentrated position", () => {
    const { ltv } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 1000, leverage: 2 },
    ]);
    expect(ltv).toBe(POOL_LTV_FLOOR);
  });

  it("rewards 3 balanced positions across distinct classes", () => {
    const { ltv, stats } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 333, leverage: 1 },
      { pairKey: "EURUSD", margin: 333, leverage: 1 },
      { pairKey: "SPX500", margin: 334, leverage: 1 },
    ]);
    expect(stats.numAssetClasses).toBe(3);
    expect(ltv).toBeGreaterThan(0.55);
    expect(ltv).toBeLessThan(POOL_LTV_CEILING);
  });

  it("approaches the ceiling for a broadly diversified, tail-hedged, low-leverage book", () => {
    const { ltv, stats } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 200, leverage: 1 },
      { pairKey: "EURUSD", margin: 200, leverage: 1 },
      { pairKey: "SPX500", margin: 200, leverage: 1 },
      { pairKey: "GOLD",   margin: 200, leverage: 1 },
      { pairKey: "OIL",    margin: 200, leverage: 1 },
    ]);
    expect(stats.numAssetClasses).toBeGreaterThanOrEqual(4);
    // Shannon is normalised against the full asset-class pool (11 classes),
    // so 5 evenly-spread classes hit ~0.83 — high but not at the ceiling.
    // The ceiling itself requires more class spread, lower max-weight, etc.
    expect(ltv).toBeGreaterThan(0.80);
    expect(ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
  });

  it("penalises a portfolio dominated by one oversized position", () => {
    const balanced = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 500, leverage: 1 },
      { pairKey: "EURUSD", margin: 500, leverage: 1 },
    ]).ltv;
    const dominated = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 900, leverage: 1 },
      { pairKey: "EURUSD", margin: 100, leverage: 1 },
    ]).ltv;
    expect(dominated).toBeLessThan(balanced);
  });

  it("rewards tail-hedge coverage (e.g. GOLD)", () => {
    const noHedge = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 500, leverage: 1 },
      { pairKey: "EURUSD", margin: 500, leverage: 1 },
    ]);
    const hedged = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 425, leverage: 1 },
      { pairKey: "EURUSD", margin: 425, leverage: 1 },
      { pairKey: "GOLD",   margin: 150, leverage: 1 }, // 15% target
    ]);
    expect(hedged.stats.tailFraction).toBeCloseTo(0.15, 2);
    expect(hedged.ltv).toBeGreaterThan(noHedge.ltv);
  });

  it("rewards leverage discipline (low leverage relative to ESMA cap)", () => {
    const highLev = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 500, leverage: 2 }, // BTC ESMA cap = 2 → at cap
      { pairKey: "EURUSD", margin: 500, leverage: 30 }, // EURUSD ESMA cap = 30 → at cap
    ]);
    const lowLev = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 500, leverage: 1 },
      { pairKey: "EURUSD", margin: 500, leverage: 5 },
    ]);
    expect(lowLev.ltv).toBeGreaterThan(highLev.ltv);
  });

  it("LTV stays inside [floor, ceiling] for any book", () => {
    const samples = [
      [],
      [{ pairKey: "BTCUSD", margin: 100, leverage: 2 }],
      [
        { pairKey: "BTCUSD", margin: 100, leverage: 1 },
        { pairKey: "EURUSD", margin: 100, leverage: 1 },
        { pairKey: "SPX500", margin: 100, leverage: 1 },
        { pairKey: "GOLD",   margin: 100, leverage: 1 },
        { pairKey: "OIL",    margin: 100, leverage: 1 },
        { pairKey: "TSLA",   margin: 100, leverage: 1 },
      ],
    ];
    for (const positions of samples) {
      const { ltv } = calcPoolLtv(positions);
      expect(ltv).toBeGreaterThanOrEqual(POOL_LTV_FLOOR);
      expect(ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
    }
  });

  it("breakdown is exposed for UI consumption", () => {
    const { breakdown } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 300, leverage: 1 },
      { pairKey: "EURUSD", margin: 300, leverage: 1 },
      { pairKey: "SPX500", margin: 400, leverage: 1 },
    ]);
    expect(breakdown).toHaveProperty("floor");
    expect(breakdown).toHaveProperty("concentrationComponent");
    expect(breakdown).toHaveProperty("diversityComponent");
    expect(breakdown).toHaveProperty("tailComponent");
    expect(breakdown).toHaveProperty("disciplineComponent");
    expect(breakdown).toHaveProperty("maxWeightPenalty");
  });
});

describe("calcAvailablePoolCredit", () => {
  it("returns 0 for a nil deposit", () => {
    expect(calcAvailablePoolCredit(0, [])).toBe(0);
  });

  it("scales with deposit × LTV minus already-deployed credit", () => {
    const positions = [
      { pairKey: "BTCUSD", margin: 300, leverage: 1 },
      { pairKey: "EURUSD", margin: 300, leverage: 1 },
      { pairKey: "SPX500", margin: 400, leverage: 1 },
    ];
    const { ltv } = calcPoolLtv(positions);
    const available = calcAvailablePoolCredit(1000, positions, 200);
    expect(available).toBeCloseTo(1000 * ltv - 200, 2);
  });

  it("never goes negative — over-budget reports 0 available", () => {
    const positions = [{ pairKey: "BTCUSD", margin: 1000, leverage: 1 }];
    const available = calcAvailablePoolCredit(1000, positions, 10000);
    expect(available).toBe(0);
  });
});

describe("isOverCreditBudget", () => {
  it("is false when no credit is deployed", () => {
    expect(isOverCreditBudget(1000, [], 0)).toBe(false);
  });

  it("is true when deployed credit exceeds deposit × LTV", () => {
    const positions = [{ pairKey: "BTCUSD", margin: 1000, leverage: 1 }];
    expect(isOverCreditBudget(1000, positions, 500)).toBe(true);
  });

  it("is false for a diversified book within budget", () => {
    const positions = [
      { pairKey: "BTCUSD", margin: 300, leverage: 1 },
      { pairKey: "EURUSD", margin: 300, leverage: 1 },
      { pairKey: "SPX500", margin: 400, leverage: 1 },
    ];
    expect(isOverCreditBudget(1000, positions, 400)).toBe(false);
  });
});
