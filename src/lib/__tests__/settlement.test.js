import { describe, it, expect } from "vitest";
import {
  geometricPnl,
  deterministicBarrierAdjustment,
} from "../settlement.js";

describe("geometricPnl", () => {
  it("is 0 when price unchanged", () => {
    expect(geometricPnl(1000, 2, 100, 100, "LONG")).toBeCloseTo(0, 5);
  });
  it("gains on LONG when price rises", () => {
    const pnl = geometricPnl(1000, 2, 100, 110, "LONG");
    expect(pnl).toBeGreaterThan(0);
  });
  it("loses on LONG when price falls", () => {
    const pnl = geometricPnl(1000, 2, 100, 90, "LONG");
    expect(pnl).toBeLessThan(0);
  });
  it("short mirrors long sign", () => {
    const longPnl = geometricPnl(1000, 2, 100, 110, "LONG");
    const shortPnl = geometricPnl(1000, 2, 100, 110, "SHORT");
    expect(shortPnl).toBeLessThan(0);
    expect(Math.sign(longPnl)).not.toBe(Math.sign(shortPnl));
  });
});

describe("deterministicBarrierAdjustment", () => {
  it("returns probTouch=0 when leverage too small", () => {
    const { probTouch } = deterministicBarrierAdjustment(100, 100, 0.02, 0.1, 1000, "LONG");
    expect(probTouch).toBe(0);
  });
  it("returns probTouch=1 when endpoint past barrier", () => {
    // 10x long, -50% move = far past barrier
    const { probTouch, adjustedMargin } = deterministicBarrierAdjustment(100, 50, 0.02, 10, 1000, "LONG");
    expect(probTouch).toBe(1);
    expect(adjustedMargin).toBeLessThan(1000);
  });
  it("probTouch is between 0 and 1", () => {
    const { probTouch } = deterministicBarrierAdjustment(100, 99, 0.02, 5, 1000, "LONG");
    expect(probTouch).toBeGreaterThanOrEqual(0);
    expect(probTouch).toBeLessThanOrEqual(1);
  });
});
