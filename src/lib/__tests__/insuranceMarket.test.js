import { describe, it, expect } from "vitest";
import {
  makeInsuranceMarket,
  postInsurer,
  withdrawInsurer,
  postInsured,
  cancelInsured,
  calcPremiumRate,
  settleMarketTick,
  totalInsurerStake,
  totalCoverageHeld,
  maxInsurerLossExposure,
  BASE_PREMIUM_RATE,
  MIN_PREMIUM_RATE,
  MAX_PREMIUM_RATE,
} from "../insuranceMarket.js";

function fresh() {
  return makeInsuranceMarket({
    eventId: "BTC_CRASH_20_WEEK",
    pairKey: "BTCUSD",
    category: "pair-price",
  });
}

// ---------------------------------------------------------------------------
// factory + posting
// ---------------------------------------------------------------------------

describe("makeInsuranceMarket", () => {
  it("starts empty with the base premium rate", () => {
    const m = fresh();
    expect(m.insurerCapital).toBe(0);
    expect(m.totalCoverage).toBe(0);
    expect(m.premiumRate).toBe(BASE_PREMIUM_RATE);
    expect(m.id).toMatch(/^INS-MKT-/);
  });
});

describe("postInsurer / postInsured", () => {
  it("accumulates insurer stakes", () => {
    let m = fresh();
    m = postInsurer({ market: m, userId: "A", amount: 100 }).market;
    m = postInsurer({ market: m, userId: "A", amount: 50 }).market;
    m = postInsurer({ market: m, userId: "B", amount: 200 }).market;
    expect(m.insurerCapital).toBe(350);
    expect(m.insurerPositions.A).toBe(150);
    expect(m.insurerPositions.B).toBe(200);
  });

  it("accumulates coverage on the insured side", () => {
    let m = fresh();
    m = postInsured({ market: m, userId: "X", faceAmount: 500 }).market;
    m = postInsured({ market: m, userId: "Y", faceAmount: 200 }).market;
    expect(m.totalCoverage).toBe(700);
    expect(m.coverage.X).toBe(500);
  });

  it("rejects zero / negative amounts", () => {
    const m = fresh();
    expect(postInsurer({ market: m, userId: "A", amount: 0 }).ok).toBe(false);
    expect(postInsured({ market: m, userId: "A", faceAmount: -10 }).ok).toBe(false);
  });
});

describe("withdrawInsurer / cancelInsured", () => {
  it("withdraws partial insurer stake", () => {
    let m = postInsurer({
      market: fresh(),
      userId: "A",
      amount: 200,
    }).market;
    const r = withdrawInsurer({ market: m, userId: "A", amount: 50 });
    expect(r.ok).toBe(true);
    expect(r.market.insurerPositions.A).toBe(150);
    expect(r.market.insurerCapital).toBe(150);
  });

  it("rejects withdrawing more than posted", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 100 }).market;
    expect(withdrawInsurer({ market: m, userId: "A", amount: 200 }).ok).toBe(false);
  });

  it("respects insurer lockup when currentEpoch is provided", () => {
    let m = postInsurer({
      market: fresh(),
      userId: "A",
      amount: 100,
      currentEpoch: 0,
    }).market;
    // Within the lockup window — withdrawal is denied.
    const blocked = withdrawInsurer({
      market: m,
      userId: "A",
      amount: 50,
      currentEpoch: 50,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/locked/i);
  });

  it("allows withdrawal after the lockup release epoch", () => {
    let m = postInsurer({
      market: fresh(),
      userId: "A",
      amount: 100,
      currentEpoch: 0,
    }).market;
    // Past the 200-tick lockup.
    const ok = withdrawInsurer({
      market: m,
      userId: "A",
      amount: 50,
      currentEpoch: 250,
    });
    expect(ok.ok).toBe(true);
  });

  it("bypassLockup: true ignores the lockup (thread-driven path)", () => {
    let m = postInsurer({
      market: fresh(),
      userId: "A",
      amount: 100,
      currentEpoch: 0,
    }).market;
    const ok = withdrawInsurer({
      market: m,
      userId: "A",
      amount: 50,
      currentEpoch: 50, // would be locked
      bypassLockup: true,
    });
    expect(ok.ok).toBe(true);
    expect(ok.market.insurerPositions.A).toBe(50);
  });

  it("the latest deposit pushes the lockup release further out", () => {
    let m = postInsurer({
      market: fresh(),
      userId: "A",
      amount: 100,
      currentEpoch: 0,
    }).market;
    m = postInsurer({
      market: m,
      userId: "A",
      amount: 100,
      currentEpoch: 100,
    }).market;
    // First deposit's release was epoch 200; second pushes to 300.
    // At epoch 250, still locked.
    const blocked = withdrawInsurer({
      market: m,
      userId: "A",
      amount: 50,
      currentEpoch: 250,
    });
    expect(blocked.ok).toBe(false);
  });

  it("cancels coverage with default = full", () => {
    let m = postInsured({ market: fresh(), userId: "X", faceAmount: 500 }).market;
    const r = cancelInsured({ market: m, userId: "X" });
    expect(r.ok).toBe(true);
    expect(r.cancelledFace).toBe(500);
    expect(r.market.coverage.X).toBeUndefined();
    expect(r.market.totalCoverage).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// premium rate
// ---------------------------------------------------------------------------

describe("calcPremiumRate", () => {
  it("equals the base rate at perfect balance", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 100 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 100 }).market;
    expect(calcPremiumRate(m)).toBeCloseTo(BASE_PREMIUM_RATE);
  });

  it("rises when insured demand exceeds insurer supply", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 100 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 400 }).market;
    expect(calcPremiumRate(m)).toBeGreaterThan(BASE_PREMIUM_RATE);
  });

  it("falls when insurer supply exceeds insured demand", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 1000 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 100 }).market;
    expect(calcPremiumRate(m)).toBeLessThan(BASE_PREMIUM_RATE);
  });

  it("clamps to [MIN, MAX]", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 1 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 1e9 }).market;
    expect(calcPremiumRate(m)).toBeLessThanOrEqual(MAX_PREMIUM_RATE);
    let m2 = postInsurer({ market: fresh(), userId: "A", amount: 1e9 }).market;
    m2 = postInsured({ market: m2, userId: "X", faceAmount: 1 }).market;
    expect(calcPremiumRate(m2)).toBeGreaterThanOrEqual(MIN_PREMIUM_RATE);
  });
});

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

describe("settleMarketTick — no trigger", () => {
  it("collects premium pro-rata from insured, distributes to insurers", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 100 }).market;
    m = postInsurer({ market: m, userId: "B", amount: 300 }).market; // 25/75 split
    m = postInsured({ market: m, userId: "X", faceAmount: 200 }).market;
    const r = settleMarketTick({ market: m, eventTriggered: false, currentEpoch: 1 });
    expect(r.premiumOut.X).toBeGreaterThan(0);
    // Total in should equal total out (modulo float)
    const out = r.premiumOut.X;
    const inn = (r.premiumIn.A ?? 0) + (r.premiumIn.B ?? 0);
    expect(inn).toBeCloseTo(out, 5);
    // 75/25 split between insurers
    expect(r.premiumIn.B / r.premiumIn.A).toBeCloseTo(3, 5);
  });
});

describe("settleMarketTick — trigger", () => {
  it("pays out coverage to insured, charges insurers pro-rata, and resets", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 1000 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 600 }).market;
    m = postInsured({ market: m, userId: "Y", faceAmount: 200 }).market;
    const r = settleMarketTick({ market: m, eventTriggered: true, currentEpoch: 5 });
    // totalCoverage 800 < insurerCapital 1000 → full coverage (no haircut).
    expect(r.claimIn.X).toBeCloseTo(600);
    expect(r.claimIn.Y).toBeCloseTo(200);
    expect(r.claimOut.A).toBeCloseTo(800);
    expect(r.market.insurerCapital).toBe(0);
    expect(r.market.totalCoverage).toBe(0);
    expect(r.market.triggerCount).toBe(1);
  });

  it("haircuts insured pro-rata when totalCoverage exceeds insurer capital", () => {
    let m = postInsurer({ market: fresh(), userId: "A", amount: 100 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 600 }).market;
    m = postInsured({ market: m, userId: "Y", faceAmount: 400 }).market;
    const r = settleMarketTick({ market: m, eventTriggered: true, currentEpoch: 5 });
    // haircut = 100/1000 = 0.1
    expect(r.claimIn.X).toBeCloseTo(60);
    expect(r.claimIn.Y).toBeCloseTo(40);
    expect(r.claimOut.A).toBeCloseTo(100);
  });

  it("trigger with empty market is a no-op", () => {
    const r = settleMarketTick({ market: fresh(), eventTriggered: true, currentEpoch: 5 });
    expect(r.claimIn).toEqual({});
    expect(r.claimOut).toEqual({});
    expect(r.market.triggerCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("aggregation helpers", () => {
  it("sums stakes / coverage across a list of markets", () => {
    let a = fresh();
    let b = fresh();
    a = postInsurer({ market: a, userId: "U", amount: 100 }).market;
    b = postInsurer({ market: b, userId: "U", amount: 50 }).market;
    a = postInsured({ market: a, userId: "U", faceAmount: 30 }).market;
    expect(totalInsurerStake([a, b], "U")).toBe(150);
    expect(totalCoverageHeld([a, b], "U")).toBe(30);
  });

  it("maxInsurerLossExposure approximates worst-case full-trigger loss", () => {
    let m = postInsurer({ market: fresh(), userId: "U", amount: 200 }).market;
    m = postInsured({ market: m, userId: "X", faceAmount: 500 }).market;
    // U owns 100% of insurer capital. totalCoverage=500, capital=200,
    // haircut=200/500=0.4. U's loss share = 1.0 × 500 × 0.4 = 200.
    expect(maxInsurerLossExposure([m], "U")).toBeCloseTo(200);
  });
});
