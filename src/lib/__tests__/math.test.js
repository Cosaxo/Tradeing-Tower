import { describe, it, expect } from "vitest";
import {
  timeWeightedYieldMult,
  calcRealizedSigma,
  calcCorrelation,
  sortino,
  calcWinRate,
  calcMaxDrawdown,
} from "../math.js";

describe("timeWeightedYieldMult", () => {
  it("is 1 at epoch 0", () => {
    expect(timeWeightedYieldMult(0)).toBe(1);
  });
  it("caps at 1.4 after 20 epochs", () => {
    expect(timeWeightedYieldMult(20)).toBeCloseTo(1.4);
    expect(timeWeightedYieldMult(100)).toBeCloseTo(1.4);
  });
  it("handles negative input as zero epochs", () => {
    expect(timeWeightedYieldMult(-5)).toBe(1);
  });
});

describe("calcRealizedSigma", () => {
  it("returns default when history too short", () => {
    expect(calcRealizedSigma([100])).toBe(0.02);
  });
  it("computes rolling log-return std", () => {
    const prices = [100, 101, 102, 103, 102.5];
    const sigma = calcRealizedSigma(prices, 4);
    expect(sigma).toBeGreaterThan(0);
    expect(sigma).toBeLessThan(0.1);
  });
});

describe("calcCorrelation", () => {
  it("returns 1 for identical series", () => {
    expect(calcCorrelation([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])).toBeCloseTo(1);
  });
  it("returns -1 for perfectly opposite series", () => {
    expect(calcCorrelation([1, 2, 3, 4, 5], [5, 4, 3, 2, 1])).toBeCloseTo(-1);
  });
  it("returns 0 for too-short series", () => {
    expect(calcCorrelation([1], [1])).toBe(0);
  });
});

describe("sortino / winRate / maxDrawdown", () => {
  it("sortino handles all-positive returns", () => {
    expect(sortino([0.01, 0.02, 0.03])).toBe(99.9);
  });
  it("winRate counts positive returns", () => {
    expect(calcWinRate([1, -1, 1, -1, 1])).toBe(0.6);
  });
  it("maxDrawdown on rising equity is 0", () => {
    const history = [1000, 1100, 1200, 1300].map((m) => ({
      users: [{ id: "You", margin: m }],
    }));
    expect(calcMaxDrawdown(history)).toBe(0);
  });
  it("maxDrawdown captures peak-trough", () => {
    const history = [1000, 1500, 1200, 900].map((m) => ({
      users: [{ id: "You", margin: m }],
    }));
    expect(calcMaxDrawdown(history)).toBeCloseTo(0.4, 2);
  });
});
