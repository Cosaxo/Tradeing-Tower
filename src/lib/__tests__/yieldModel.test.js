import { describe, it, expect } from "vitest";
import {
  updateYieldModel,
  calcYieldStripValue,
  jumpAdjustedSigma,
  calcStripPremium,
  dynamicBufferRate,
  calcYieldBufferContribution,
} from "../yieldModel.js";

describe("updateYieldModel", () => {
  const init = { yieldEq: 0.02, kappa: 0.1, prevYield: 0.02, prevChange: 0, acov: 0, yieldVar: 0.0001 };

  it("preserves shape of returned state", () => {
    const next = updateYieldModel(init, 0.025);
    expect(Object.keys(next).sort()).toEqual(
      ["acov", "kappa", "prevChange", "prevYield", "yieldEq", "yieldVar"].sort()
    );
  });

  it("EMA drifts equilibrium toward observed yield", () => {
    let state = init;
    for (let i = 0; i < 50; i++) state = updateYieldModel(state, 0.05);
    expect(state.yieldEq).toBeGreaterThan(0.02);
  });
});

describe("calcYieldStripValue", () => {
  it("returns positive PV for positive yield", () => {
    const pv = calcYieldStripValue(2, 10000, 10, 0.001, { yieldEq: 0.02, kappa: 0.1 });
    expect(pv).toBeGreaterThan(0);
  });
});

describe("jumpAdjustedSigma", () => {
  it("inflates sigma when jumps present", () => {
    const returns = [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.2];
    const adj = jumpAdjustedSigma(0.02, returns);
    expect(adj).toBeGreaterThan(0.02);
  });
  it("returns sigma when too few returns", () => {
    expect(jumpAdjustedSigma(0.02, [])).toBe(0.02);
  });
});

describe("calcStripPremium", () => {
  it("is bounded between 0.0001 and 0.08", () => {
    const p = calcStripPremium(5, 0.03, 0.2, 0.5, []);
    expect(p).toBeGreaterThanOrEqual(0.0001);
    expect(p).toBeLessThanOrEqual(0.08);
  });
});

describe("dynamicBufferRate", () => {
  it("max rate when buffer is empty", () => {
    const r = dynamicBufferRate(0, 0);
    expect(r).toBeCloseTo(0.15, 2);
  });
  it("reduces toward min as buffer fills", () => {
    const empty = dynamicBufferRate(0, 0);
    const full = dynamicBufferRate(5000, 0);
    expect(full).toBeLessThan(empty);
  });
  it("loyalty discount reduces rate further", () => {
    const base = dynamicBufferRate(2500, 0);
    const loyal = dynamicBufferRate(2500, 25);
    expect(loyal).toBeLessThan(base);
  });
});

describe("calcYieldBufferContribution", () => {
  it("is 0 when yield below threshold", () => {
    expect(calcYieldBufferContribution(0.01, 0, 0)).toBe(0);
  });
  it("scales with excess yield", () => {
    const small = calcYieldBufferContribution(0.06, 0, 0);
    const big = calcYieldBufferContribution(0.2, 0, 0);
    expect(big).toBeGreaterThan(small);
  });
});
