import { describe, it, expect } from "vitest";
import { getEsmaCap, getEffectiveCap } from "../esma.js";

describe("ESMA caps", () => {
  it("crypto capped at 2x", () => {
    expect(getEsmaCap("BTC-PERP")).toBe(2);
  });
  it("FX major capped at 30x", () => {
    expect(getEsmaCap("EURUSD")).toBe(30);
  });
});

describe("getEffectiveCap", () => {
  it("returns ESMA when vol is low", () => {
    const { effectiveCap, bindingConstraint } = getEffectiveCap("EURUSD", 0.001);
    expect(effectiveCap).toBe(30);
    expect(bindingConstraint).toBe("ESMA");
  });

  it("vol cap binds when vol is high", () => {
    const { effectiveCap, bindingConstraint } = getEffectiveCap("EURUSD", 2.0);
    expect(effectiveCap).toBeLessThan(30);
    expect(bindingConstraint).toBe("VOL");
  });

  it("floor at 1 (Math.max in esma.js)", () => {
    const { effectiveCap } = getEffectiveCap("EURUSD", 100);
    expect(effectiveCap).toBeGreaterThanOrEqual(1);
  });
});
