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
      { pairKey: "BTCUSD", margin: 1000 },
    ]);
    // Single-position HHI = 1, maxWeight = 1.0, diversity = 0.
    // LTV = floor + 0 + (0.35 × 0) − (0.25 × 1.0) = 0.30 - 0.25 = 0.05, floored to 0.30.
    expect(ltv).toBe(POOL_LTV_FLOOR);
  });

  it("rewards 3 balanced positions across distinct classes", () => {
    const { ltv, stats } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 333 },
      { pairKey: "EURUSD", margin: 333 },
      { pairKey: "SPX500", margin: 334 },
    ]);
    expect(stats.numAssetClasses).toBe(3);
    // Should be meaningfully above floor, below ceiling.
    expect(ltv).toBeGreaterThan(0.55);
    expect(ltv).toBeLessThan(POOL_LTV_CEILING);
  });

  it("reaches / approaches the ceiling for a broadly diversified book", () => {
    const { ltv, stats } = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 200 },
      { pairKey: "EURUSD", margin: 200 },
      { pairKey: "SPX500", margin: 200 },
      { pairKey: "GOLD", margin: 200 },
      { pairKey: "OIL", margin: 200 },
    ]);
    expect(stats.numAssetClasses).toBeGreaterThanOrEqual(4);
    expect(ltv).toBeGreaterThan(0.80);
    expect(ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
  });

  it("penalises a portfolio dominated by one oversized position", () => {
    const balanced = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 500 },
      { pairKey: "EURUSD", margin: 500 },
    ]).ltv;
    const dominated = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 900 },
      { pairKey: "EURUSD", margin: 100 },
    ]).ltv;
    expect(dominated).toBeLessThan(balanced);
  });

  it("floors and ceilings are always respected", () => {
    const floor = calcPoolLtv([{ pairKey: "BTCUSD", margin: 10000 }]).ltv;
    expect(floor).toBeGreaterThanOrEqual(POOL_LTV_FLOOR);
    const ceil = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 100 },
      { pairKey: "EURUSD", margin: 100 },
      { pairKey: "SPX500", margin: 100 },
      { pairKey: "GOLD", margin: 100 },
      { pairKey: "OIL", margin: 100 },
      { pairKey: "TSLA", margin: 100 },
    ]).ltv;
    expect(ceil).toBeLessThanOrEqual(POOL_LTV_CEILING);
  });

  it("exposes a breakdown that sums to the LTV (before clamp)", () => {
    const result = calcPoolLtv([
      { pairKey: "BTCUSD", margin: 300 },
      { pairKey: "EURUSD", margin: 300 },
      { pairKey: "SPX500", margin: 400 },
    ]);
    const { floor, diversityComponent, concentrationComponent, maxWeightPenalty } =
      result.breakdown;
    const reconstructed =
      floor + diversityComponent + concentrationComponent - maxWeightPenalty;
    expect(result.ltv).toBeCloseTo(
      Math.max(POOL_LTV_FLOOR, Math.min(POOL_LTV_CEILING, reconstructed)),
      3
    );
  });
});

describe("calcAvailablePoolCredit", () => {
  it("returns 0 for a nil deposit", () => {
    expect(calcAvailablePoolCredit(0, [])).toBe(0);
  });

  it("scales with deposit × LTV minus already-deployed credit", () => {
    const positions = [
      { pairKey: "BTCUSD", margin: 300 },
      { pairKey: "EURUSD", margin: 300 },
      { pairKey: "SPX500", margin: 400 },
    ];
    const { ltv } = calcPoolLtv(positions);
    const available = calcAvailablePoolCredit(1000, positions, 200);
    expect(available).toBeCloseTo(1000 * ltv - 200, 2);
  });

  it("never goes negative — over-budget reports 0 available", () => {
    const positions = [{ pairKey: "BTCUSD", margin: 1000 }];
    const available = calcAvailablePoolCredit(1000, positions, 10000);
    expect(available).toBe(0);
  });
});

describe("isOverCreditBudget", () => {
  it("is false when no credit is deployed", () => {
    expect(isOverCreditBudget(1000, [], 0)).toBe(false);
  });

  it("is true when deployed credit exceeds deposit × LTV", () => {
    const positions = [{ pairKey: "BTCUSD", margin: 1000 }];
    expect(isOverCreditBudget(1000, positions, 500)).toBe(true); // floor LTV = 0.3
  });

  it("is false for a diversified book within budget", () => {
    const positions = [
      { pairKey: "BTCUSD", margin: 300 },
      { pairKey: "EURUSD", margin: 300 },
      { pairKey: "SPX500", margin: 400 },
    ];
    expect(isOverCreditBudget(1000, positions, 400)).toBe(false);
  });
});
