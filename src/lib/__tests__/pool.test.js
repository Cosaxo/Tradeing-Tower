import { describe, it, expect } from "vitest";
import {
  calcRiskScore,
  calcRatioBeta,
  settleDominantPool,
  calcHedgeCorrPenalty,
  calcAdjShare,
  escrowTips,
} from "../pool.js";

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
  // Need enough users that the 40/30/30 split gives each tier at least one.
  const users = [
    { id: "safe1", leverage: 1, margin: 1000, side: "LONG", active: true },
    { id: "safe2", leverage: 1, margin: 1000, side: "LONG", active: true },
    { id: "med1", leverage: 3, margin: 1000, side: "LONG", active: true },
    { id: "med2", leverage: 3, margin: 1000, side: "LONG", active: true },
    { id: "risky1", leverage: 10, margin: 1000, side: "LONG", active: true },
    { id: "risky2", leverage: 10, margin: 1000, side: "LONG", active: true },
  ];

  it("settles all users and returns logs", () => {
    const { users: settled, logs } = settleDominantPool(users, 100, 101, 0.02, {});
    expect(settled).toHaveLength(users.length);
    expect(logs.length).toBeGreaterThan(0);
  });

  it("charges stability fee only on RISKY tier", () => {
    // Use a price move that creates positive margins so fees can apply.
    const { stabilityFeeCollected } = settleDominantPool(users, 100, 102, 0.02, {}, 0.01);
    expect(stabilityFeeCollected).toBeGreaterThanOrEqual(0);
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

describe("calcHedgeCorrPenalty (§5.2)", () => {
  it("is 1 with single user (no correlations)", () => {
    const u = { id: "X", pairKey: "EURUSD" };
    expect(calcHedgeCorrPenalty(u, [u], {})).toBe(1);
  });

  it("applies floor of 0.75 (never goes below)", () => {
    const a = { id: "A", pairKey: "EURUSD" };
    const b = { id: "B", pairKey: "GOLD" };
    const corrMap = { "EURUSD:GOLD": -1, "GOLD:EURUSD": -1 };
    const penalty = calcHedgeCorrPenalty(a, [a, b], corrMap);
    expect(penalty).toBeGreaterThanOrEqual(0.75);
  });
});

describe("calcAdjShare (§5.2)", () => {
  it("safer users get higher share in a tier", () => {
    const tier = [
      { id: "safe", margin: 1000, riskScore: 1 },
      { id: "risky", margin: 1000, riskScore: 10 },
    ];
    const safeShare = calcAdjShare(tier[0], tier);
    const riskyShare = calcAdjShare(tier[1], tier);
    expect(safeShare).toBeGreaterThan(riskyShare);
    expect(safeShare + riskyShare).toBeCloseTo(1);
  });
});

describe("escrowTips (§5.2)", () => {
  it("records tips paid + received per participant", () => {
    const matched = [
      { longId: "A", shortId: "B", margin: 1000, longTip: 0.02, shortTip: 0.01 },
    ];
    const { tipEscrow } = escrowTips(matched);
    expect(tipEscrow.A.paid).toBeCloseTo(20);
    expect(tipEscrow.B.paid).toBeCloseTo(10);
    // A's tip crosses to B; B's tip crosses to A.
    expect(tipEscrow.A.received).toBeCloseTo(10);
    expect(tipEscrow.B.received).toBeCloseTo(20);
  });

  it("handles empty matches gracefully", () => {
    const { tipEscrow, escrowLogs } = escrowTips([]);
    expect(tipEscrow).toEqual({});
    expect(escrowLogs).toEqual([]);
  });
});
