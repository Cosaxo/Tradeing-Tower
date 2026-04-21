import { describe, it, expect } from "vitest";
import {
  calcStressThresholds,
  propagateShock,
  applyShockToPositions,
  calcSystemSolvencyBuffer,
} from "../stress.js";

describe("calcStressThresholds", () => {
  it("high leverage → closer liquidation price", () => {
    const low = calcStressThresholds({ leverage: 1, side: "LONG", margin: 1000 }, 100);
    const high = calcStressThresholds({ leverage: 10, side: "LONG", margin: 1000 }, 100);
    expect(high.liqMove).toBeLessThan(low.liqMove);
  });

  it("returns Infinity liqMove when leverage is 0", () => {
    const r = calcStressThresholds({ leverage: 0, side: "LONG", margin: 1000 }, 100);
    expect(r.liqMove).toBe(Infinity);
  });

  it("short-side liquidation is above current price", () => {
    const r = calcStressThresholds({ leverage: 5, side: "SHORT", margin: 1000 }, 100);
    expect(r.liqPrice).toBeGreaterThan(100);
  });
});

describe("propagateShock", () => {
  it("origin pair gets full shock", () => {
    const impact = propagateShock("A", -0.2, {}, ["A", "B", "C"]);
    expect(impact.A).toBe(-0.2);
  });

  it("transmission decays by correlation * 0.7", () => {
    const corr = { "A:B": 0.5, "B:A": 0.5 };
    const impact = propagateShock("A", -0.2, corr, ["A", "B"]);
    expect(impact.B).toBeCloseTo(-0.2 * 0.5 * 0.7);
  });

  it("uncorrelated pair receives zero transmission", () => {
    const impact = propagateShock("A", -0.2, {}, ["A", "B"]);
    expect(impact.B).toBeCloseTo(0);
  });
});

describe("applyShockToPositions", () => {
  it("counts liquidations", () => {
    const positions = [
      { pairKey: "A", leverage: 20, margin: 1000, side: "LONG" },
    ];
    const result = applyShockToPositions(positions, { A: -0.5 }, { A: 100 }, 0.02);
    expect(result.liquidated).toBe(1);
  });
});

describe("calcSystemSolvencyBuffer", () => {
  it("solvent=true for deposits-only state", () => {
    const r = calcSystemSolvencyBuffer({}, 10000);
    expect(r.solvent).toBe(true);
  });

  it("tracks total exposure + margin", () => {
    const pairStates = {
      A: { users: [{ active: true, margin: 1000, leverage: 2 }] },
    };
    const r = calcSystemSolvencyBuffer(pairStates, 0);
    expect(r.totalExposure).toBe(2000);
    expect(r.totalMargin).toBe(1000);
    expect(r.solvencyBuffer).toBeCloseTo(0.5);
  });
});
