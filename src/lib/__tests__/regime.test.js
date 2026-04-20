import { describe, it, expect } from "vitest";
import { REGIMES, detectRegime } from "../regime.js";

describe("REGIMES constants", () => {
  it("every regime has label and color", () => {
    for (const k of Object.keys(REGIMES)) {
      expect(REGIMES[k].label).toBeDefined();
      expect(REGIMES[k].color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(REGIMES[k].sigmaAdj).toBeGreaterThan(0);
      expect(REGIMES[k].muAdj).toBeGreaterThan(0);
    }
  });
});

describe("detectRegime", () => {
  it("returns CALM on too-short history", () => {
    const r = detectRegime([0.001]);
    expect(r.key).toBe("CALM");
  });

  it("flags TRENDING_UP on sustained positive returns", () => {
    const returns = Array(20).fill(0.005);
    const r = detectRegime(returns);
    expect(r.key).toBe("TRENDING_UP");
  });

  it("flags TRENDING_DN on sustained negative returns", () => {
    const returns = Array(20).fill(-0.005);
    const r = detectRegime(returns);
    expect(r.key).toBe("TRENDING_DN");
  });

  it("flags HIGH_VOL when short-window vol >> long-window vol", () => {
    const returns = [
      ...Array(15).fill(0.001),
      0.05, 0.06, -0.07, 0.08, -0.05,
    ];
    const r = detectRegime(returns);
    expect(["HIGH_VOL", "CRASH"]).toContain(r.key);
  });
});
