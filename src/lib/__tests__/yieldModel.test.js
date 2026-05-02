import { describe, it, expect } from "vitest";
import { updateYieldModel } from "../yieldModel.js";

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

  it("converges back when yield returns to baseline", () => {
    let state = init;
    for (let i = 0; i < 50; i++) state = updateYieldModel(state, 0.05);
    for (let i = 0; i < 200; i++) state = updateYieldModel(state, 0.02);
    expect(state.yieldEq).toBeLessThan(0.025);
  });
});
