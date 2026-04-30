import { describe, it, expect } from "vitest";
import {
  REINSURANCE_PRODUCTS,
  REINSURANCE_LOCKUP_EPOCHS,
  makeReinsuranceSet,
  postReinsuranceSeller,
  withdrawReinsuranceSeller,
  postReinsuranceBuyer,
  calcReinsurancePremiumRate,
  settleReinsuranceTick,
  totalReinsuranceCoverage,
  effectiveCoverageFraction,
} from "../reinsurance.js";

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

describe("makeReinsuranceSet", () => {
  it("returns exactly three products with declared coverage fractions", () => {
    const set = makeReinsuranceSet();
    expect(set).toHaveLength(3);
    const sumCoverage = set.reduce((s, p) => s + p.coverageFraction, 0);
    expect(sumCoverage).toBeCloseTo(1.0, 5);
    const productIds = set.map((p) => p.productId);
    for (const expected of REINSURANCE_PRODUCTS) {
      expect(productIds).toContain(expected.id);
    }
  });
});

// ---------------------------------------------------------------------------
// posting
// ---------------------------------------------------------------------------

describe("postReinsuranceSeller", () => {
  it("records the seller stake and a future lockup-release epoch", () => {
    let p = makeReinsuranceSet()[0];
    const r = postReinsuranceSeller({
      product: p,
      userId: "A",
      amount: 1000,
      currentEpoch: 10,
    });
    expect(r.ok).toBe(true);
    expect(r.product.sellerPositions.A).toBe(1000);
    expect(r.product.sellerCapital).toBe(1000);
    expect(r.product.sellerLockupReleaseEpoch.A).toBe(10 + REINSURANCE_LOCKUP_EPOCHS);
  });

  it("additional deposits push the lockup further out, never closer", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 500, currentEpoch: 0 }).product;
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 500, currentEpoch: 50 }).product;
    expect(p.sellerLockupReleaseEpoch.A).toBe(50 + REINSURANCE_LOCKUP_EPOCHS);
  });
});

describe("withdrawReinsuranceSeller", () => {
  it("blocks withdrawal during lockup", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 1000, currentEpoch: 0 }).product;
    const r = withdrawReinsuranceSeller({
      product: p,
      userId: "A",
      amount: 100,
      currentEpoch: REINSURANCE_LOCKUP_EPOCHS - 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/locked/);
  });

  it("allows withdrawal after lockup", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 1000, currentEpoch: 0 }).product;
    const r = withdrawReinsuranceSeller({
      product: p,
      userId: "A",
      amount: 200,
      currentEpoch: REINSURANCE_LOCKUP_EPOCHS + 1,
    });
    expect(r.ok).toBe(true);
    expect(r.product.sellerCapital).toBe(800);
  });
});

// ---------------------------------------------------------------------------
// premium rate
// ---------------------------------------------------------------------------

describe("calcReinsurancePremiumRate", () => {
  it("returns the base rate at perfect balance", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 1000, currentEpoch: 0 }).product;
    p = postReinsuranceBuyer({ product: p, userId: "X", faceAmount: 1000 }).product;
    const rate = calcReinsurancePremiumRate(p);
    // Base = 0.010 (REINSURANCE_BASE_RATE). At ratio = 1, should be the base.
    expect(rate).toBeCloseTo(0.010, 5);
  });

  it("rises with buyer demand", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "A", amount: 100, currentEpoch: 0 }).product;
    p = postReinsuranceBuyer({ product: p, userId: "X", faceAmount: 400 }).product;
    expect(calcReinsurancePremiumRate(p)).toBeGreaterThan(0.010);
  });
});

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

describe("settleReinsuranceTick", () => {
  function fullySetup() {
    let p = makeReinsuranceSet()[0]; // coverageFraction 0.30
    p = postReinsuranceSeller({ product: p, userId: "S", amount: 1000, currentEpoch: 0 }).product;
    p = postReinsuranceBuyer({ product: p, userId: "B", faceAmount: 500 }).product;
    return p;
  }

  it("pays out coverageFraction × loss to a buyer that incurred losses", () => {
    let p = fullySetup();
    const r = settleReinsuranceTick({
      product: p,
      buyerLossesByUser: { B: 100 },
      currentEpoch: 1,
    });
    // 0.30 × 100 = 30 owed; capped by face 500 → 30.
    expect(r.payouts.B).toBeCloseTo(30);
    // Seller S owns 100% of pot, takes the 30 hit.
    expect(r.sellerLosses.S).toBeCloseTo(30);
    expect(r.product.sellerCapital).toBeCloseTo(970);
  });

  it("respects buyer face cap", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "S", amount: 1000, currentEpoch: 0 }).product;
    p = postReinsuranceBuyer({ product: p, userId: "B", faceAmount: 10 }).product;
    const r = settleReinsuranceTick({
      product: p,
      buyerLossesByUser: { B: 1000 },
      currentEpoch: 1,
    });
    // 0.30 × 1000 = 300, but face cap = 10.
    expect(r.payouts.B).toBeCloseTo(10);
  });

  it("haircuts when seller pot cannot cover total payout", () => {
    let p = makeReinsuranceSet()[0];
    p = postReinsuranceSeller({ product: p, userId: "S", amount: 50, currentEpoch: 0 }).product;
    p = postReinsuranceBuyer({ product: p, userId: "B", faceAmount: 1000 }).product;
    const r = settleReinsuranceTick({
      product: p,
      buyerLossesByUser: { B: 1000 },
      currentEpoch: 1,
    });
    // Target 0.30 × 1000 = 300; pot only 50 → 50.
    expect(r.payouts.B).toBeCloseTo(50);
    expect(r.product.sellerCapital).toBeCloseTo(0);
  });

  it("collects premium when no losses occur", () => {
    let p = fullySetup();
    const r = settleReinsuranceTick({
      product: p,
      buyerLossesByUser: {},
      currentEpoch: 1,
    });
    expect(r.payouts).toEqual({});
    expect(r.premiumOut.B).toBeGreaterThan(0);
    expect(r.premiumIn.S).toBeCloseTo(r.premiumOut.B, 5);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

describe("totalReinsuranceCoverage / effectiveCoverageFraction", () => {
  it("sums coverage across products", () => {
    const set = makeReinsuranceSet();
    let products = set.map((p, i) =>
      i === 0 ? postReinsuranceBuyer({ product: p, userId: "U", faceAmount: 100 }).product : p
    );
    products = products.map((p, i) =>
      i === 1 ? postReinsuranceBuyer({ product: p, userId: "U", faceAmount: 200 }).product : p
    );
    expect(totalReinsuranceCoverage(products, "U")).toBe(300);
  });

  it("effectiveCoverageFraction approaches 1.0 with all 3 fully bought", () => {
    let products = makeReinsuranceSet().map((p) =>
      postReinsuranceBuyer({ product: p, userId: "U", faceAmount: 1000 }).product
    );
    const frac = effectiveCoverageFraction(products, "U", 1000);
    expect(frac).toBeCloseTo(1.0, 5);
  });

  it("effectiveCoverageFraction is partial with only one product", () => {
    const set = makeReinsuranceSet();
    const products = [
      postReinsuranceBuyer({ product: set[0], userId: "U", faceAmount: 1000 }).product,
      set[1],
      set[2],
    ];
    const frac = effectiveCoverageFraction(products, "U", 1000);
    expect(frac).toBeCloseTo(set[0].coverageFraction);
  });
});
