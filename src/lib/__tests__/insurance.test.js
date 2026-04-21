import { describe, it, expect } from "vitest";
import {
  initInsurancePool,
  calcAuctionDepthScore,
  depthToYieldMultiplier,
  calcInsurancePremium,
  settleInsurancePool,
} from "../insurance.js";

describe("initInsurancePool", () => {
  it("has zero deposits / pending / history at init", () => {
    const p = initInsurancePool();
    expect(p.totalDeposits).toBe(0);
    expect(p.pendingPremiums).toBe(0);
    expect(p.pendingClaims).toBe(0);
    expect(p.claimsHistory).toEqual([]);
  });
});

describe("calcInsurancePremium", () => {
  it("scales with exposure", () => {
    const low = calcInsurancePremium(1000, 0.01);
    const high = calcInsurancePremium(10000, 0.01);
    expect(high).toBeGreaterThan(low);
  });
  it("scales with realized sigma (up to 5x)", () => {
    const calm = calcInsurancePremium(1000, 0.005);
    const volatile = calcInsurancePremium(1000, 0.1);
    expect(volatile).toBeGreaterThan(calm);
  });
});

describe("calcAuctionDepthScore", () => {
  it("returns 0 for null auction", () => {
    expect(calcAuctionDepthScore(null)).toBe(0);
  });
  it("returns 1 for empty curves", () => {
    expect(
      calcAuctionDepthScore({ dominantSide: "LONG", longCurve: [], shortCurve: [] })
    ).toBe(1);
  });
});

describe("depthToYieldMultiplier", () => {
  it("near 1x for calm depth", () => {
    expect(depthToYieldMultiplier(0)).toBeCloseTo(1, 0);
  });
  it("near 3x for crisis depth", () => {
    expect(depthToYieldMultiplier(1)).toBeGreaterThan(2.5);
  });
});

describe("settleInsurancePool", () => {
  it("returns pool + log + flow object", () => {
    const pool = initInsurancePool();
    const { pool: settled, log, flow } = settleInsurancePool(pool, {}, 0);
    expect(settled).toBeDefined();
    expect(Array.isArray(log)).toBe(true);
    expect(flow).toBeDefined();
    expect(typeof flow.rawRevenue).toBe("number");
    expect(typeof flow.claimsPaid).toBe("number");
    expect(typeof flow.netDistrib).toBe("number");
  });

  it("routes pending premiums to depositors (net of claims)", () => {
    const pool = {
      ...initInsurancePool(),
      deposits: { A: { amount: 1000, depositEpoch: 0, lockupRemaining: 0 } },
      totalDeposits: 1000,
      pendingPremiums: 100,
    };
    const { pool: settled, flow } = settleInsurancePool(pool, {}, 5);
    expect(flow.claimsPaid).toBe(0);
    expect(flow.netDistrib).toBeGreaterThan(0);
    expect(settled.deposits.A.amount).toBeGreaterThan(1000);
  });

  it("pays claims capped at 50% of deposits", () => {
    const pool = {
      ...initInsurancePool(),
      deposits: { A: { amount: 1000, depositEpoch: 0, lockupRemaining: 0 } },
      totalDeposits: 1000,
      pendingPremiums: 0,
      pendingClaims: 900,
    };
    const { flow } = settleInsurancePool(pool, {}, 1);
    expect(flow.claimsPaid).toBeCloseTo(500);
    expect(flow.unmetClaims).toBeCloseTo(400);
  });

  it("resets pendingPremiums to zero after settlement", () => {
    const pool = {
      ...initInsurancePool(),
      pendingPremiums: 100,
      pendingStabilityFee: 50,
    };
    const { pool: settled } = settleInsurancePool(pool, {}, 0);
    expect(settled.pendingPremiums).toBe(0);
    expect(settled.pendingStabilityFee).toBe(0);
  });
});
