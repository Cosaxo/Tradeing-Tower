import { describe, it, expect } from "vitest";
import { calcRiskScore, calcRatioBeta, settleDominantPool } from "../pool.js";

describe("calcRatioBeta", () => {
  it("returns 0.5 on empty book", () => {
    expect(calcRatioBeta(0, 0)).toBe(0.5);
  });
  it("returns 1 when only longs", () => {
    expect(calcRatioBeta(1000, 0)).toBe(1);
  });
  it("returns 0 when only shorts", () => {
    expect(calcRatioBeta(0, 1000)).toBe(0);
  });
});

describe("calcRiskScore", () => {
  it("scales with leverage × sigma × margin", () => {
    const low = calcRiskScore({ leverage: 1, margin: 1000 }, 0.01);
    const high = calcRiskScore({ leverage: 5, margin: 1000 }, 0.01);
    expect(high).toBeGreaterThan(low);
  });
  it("includes correlation penalty", () => {
    const base = calcRiskScore({ leverage: 2, margin: 1000 }, 0.01, 1);
    const penalised = calcRiskScore({ leverage: 2, margin: 1000 }, 0.01, 1.5);
    expect(penalised).toBeGreaterThan(base);
  });
});

describe("settleDominantPool", () => {
  const users = [
    { id: "safe", leverage: 1, margin: 1000, side: "LONG", active: true },
    { id: "med", leverage: 3, margin: 1000, side: "LONG", active: true },
    { id: "risky", leverage: 10, margin: 1000, side: "LONG", active: true },
  ];

  it("settles all users and returns logs", () => {
    const { users: settled, logs } = settleDominantPool(users, 100, 101, 0.02, {});
    expect(settled).toHaveLength(3);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("charges stability fee only on RISKY tier", () => {
    const { stabilityFeeCollected } = settleDominantPool(users, 100, 101, 0.02, {}, 0.01);
    expect(stabilityFeeCollected).toBeGreaterThan(0);
  });

  it("flips active=false on liquidation", () => {
    const leveredUsers = [
      { id: "blown", leverage: 20, margin: 1000, side: "LONG", active: true },
    ];
    const { users: settled } = settleDominantPool(leveredUsers, 100, 80, 0.02, {});
    expect(settled[0].active).toBe(false);
    expect(settled[0].liquidated).toBe(true);
    expect(settled[0].margin).toBe(0);
  });
});
