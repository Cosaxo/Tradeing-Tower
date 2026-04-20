import { describe, it, expect } from "vitest";
import {
  calcCrossMarketCorrelations,
  getPairCorr,
  portfolioCorrelationPenalty,
} from "../correlation.js";
import { ACTIVE_PAIRS } from "../../constants/assets.js";

describe("calcCrossMarketCorrelations", () => {
  it("returns symmetric map", () => {
    const a = ACTIVE_PAIRS[0];
    const b = ACTIVE_PAIRS[1];
    const histories = {
      [a]: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110],
      [b]: [50, 50.5, 51, 51.5, 52, 52.5, 53, 53.5, 54, 54.5, 55],
    };
    const map = calcCrossMarketCorrelations(histories);
    expect(map[`${a}:${b}`]).toBeCloseTo(map[`${b}:${a}`], 8);
  });

  it("skips pairs with too-short history", () => {
    const a = ACTIVE_PAIRS[0];
    const b = ACTIVE_PAIRS[1];
    const map = calcCrossMarketCorrelations({
      [a]: [100, 101],
      [b]: [50, 50.5],
    });
    expect(map[`${a}:${b}`]).toBeUndefined();
  });
});

describe("getPairCorr", () => {
  it("returns 1 for same pair", () => {
    expect(getPairCorr({}, "EURUSD", "EURUSD")).toBe(1);
  });
  it("returns 0 when missing", () => {
    expect(getPairCorr({}, "EURUSD", "GBPUSD")).toBe(0);
  });
  it("looks up either direction", () => {
    const map = { "A:B": 0.7 };
    expect(getPairCorr(map, "A", "B")).toBe(0.7);
    expect(getPairCorr(map, "B", "A")).toBe(0.7);
  });
});

describe("portfolioCorrelationPenalty", () => {
  it("returns 1 for singleton portfolio", () => {
    expect(portfolioCorrelationPenalty(["EURUSD"], {})).toBe(1);
  });
  it("scales with average pairwise correlation", () => {
    const map = { "A:B": 0.9, "B:A": 0.9 };
    const p = portfolioCorrelationPenalty(["A", "B"], map);
    expect(p).toBeCloseTo(1.9);
  });
});
