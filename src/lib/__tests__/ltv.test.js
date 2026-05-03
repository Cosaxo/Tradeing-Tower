import { describe, it, expect } from "vitest";
import {
  calcAllocationLtv,
  calcAvailableCredit,
  isOverCreditBudget,
  evaluateTier3Gate,
  calcAllocationIndependence,
  calcReinsuranceCoverageRatio,
  POOL_LTV_FLOOR,
  POOL_LTV_CEILING,
  MIN_TIER3_MARKETS,
} from "../ltv.js";
import { makeInsuranceMarket } from "../insuranceMarket.js";
import { applyAllocations } from "../allocations.js";

function makeMarkets(eventIds, opts = {}) {
  const { pairKey = null, category = "macro" } = opts;
  return eventIds.map((eventId) =>
    makeInsuranceMarket({ eventId, pairKey, category })
  );
}

// Build a fully-funded reinsurance set covering `userId` for `face` per
// product. Three products, coverageFractions 0.30 / 0.30 / 0.40 — sum 1.
function makeReinsuranceCovering(userId, face) {
  return [
    {
      id: "R1",
      coverageFraction: 0.30,
      buyerCoverage: { [userId]: face },
      sellerCapital: 1e6,
      sellerPositions: { S: 1e6 },
    },
    {
      id: "R2",
      coverageFraction: 0.30,
      buyerCoverage: { [userId]: face },
      sellerCapital: 1e6,
      sellerPositions: { S: 1e6 },
    },
    {
      id: "R3",
      coverageFraction: 0.40,
      buyerCoverage: { [userId]: face },
      sellerCapital: 1e6,
      sellerPositions: { S: 1e6 },
    },
  ];
}

describe("calcAllocationLtv", () => {
  it("returns the floor when user has no allocation", () => {
    const markets = makeMarkets(["E1", "E2", "E3"]);
    const r = calcAllocationLtv({ markets, userId: "Alice" });
    expect(r.ltv).toBe(POOL_LTV_FLOOR);
  });

  it("stays at the floor for a single concentrated allocation", () => {
    let markets = makeMarkets(["E1", "E2"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1.0 } },
      totalCapital: 1000,
    }).markets;
    const r = calcAllocationLtv({ markets, userId: "A" });
    expect(r.ltv).toBe(POOL_LTV_FLOOR);
  });

  it("rises with even allocation across multiple markets but caps below ceiling without reinsurance", () => {
    let markets = makeMarkets(["E1", "E2", "E3", "E4"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: {
          [markets[0].eventId]: 0.25,
          [markets[1].eventId]: 0.25,
          [markets[2].eventId]: 0.25,
          [markets[3].eventId]: 0.25,
        },
      },
      totalCapital: 1000,
    }).markets;
    const r = calcAllocationLtv({ markets, userId: "A" });
    // No reinsurance bought → coverageRatio term contributes 0.
    // All-macro events → independence term contributes ~0.5 × W_INDEP.
    expect(r.ltv).toBeGreaterThan(POOL_LTV_FLOOR);
    // Should NOT be near the ceiling without reinsurance.
    expect(r.ltv).toBeLessThan(0.85);
  });

  it("reaches the ceiling only with full reinsurance + independence + diversification", () => {
    const ids = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
    // Mix pairKeys so the independence score is high (no two share a pair).
    const pairKeys = [
      "BTCUSD", "ETHUSD", "SPX500", "GOLD",
      "EURUSD", "GBPUSD", "USDJPY", "OIL",
    ];
    let markets = ids.map((eventId, i) =>
      makeInsuranceMarket({ eventId, pairKey: pairKeys[i], category: "pair-price" })
    );
    const allocs = {};
    for (const m of markets) allocs[m.eventId] = 1 / ids.length;
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: allocs },
      totalCapital: 8000,
    }).markets;

    // Full reinsurance: each product's coverage equals the stake. Faces
    // sum to 3× stake; weighted by coverageFraction (0.30 + 0.30 + 0.40
    // = 1.0) → coverageRatio = 1.
    const reinsurance = makeReinsuranceCovering("A", 8000);

    // Empty correlation map → all distinct pair-key pairings get
    // |corr| = 0 → independence ≈ 1.
    const r = calcAllocationLtv({
      markets,
      userId: "A",
      reinsurance,
      correlationMap: {},
    });
    // 8 even allocations means HHI = 0.125, so concentration term lands
    // at 0.10 × 0.875 instead of the full 0.10 — total comes in at
    // ~0.9875, near but not exactly at the ceiling.
    expect(r.ltv).toBeGreaterThan(0.95);
    expect(r.ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
  });

  it("penalises a portfolio with one >50% allocation", () => {
    let markets = makeMarkets(["E1", "E2", "E3", "E4"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: {
          [markets[0].eventId]: 0.7,
          [markets[1].eventId]: 0.1,
          [markets[2].eventId]: 0.1,
          [markets[3].eventId]: 0.1,
        },
      },
      totalCapital: 1000,
    }).markets;
    const r = calcAllocationLtv({ markets, userId: "A" });
    expect(r.breakdown.maxWeightPenalty).toBeGreaterThan(0);
    expect(r.ltv).toBeLessThan(POOL_LTV_CEILING);
  });

  it("LTV stays in [floor, ceiling] for any allocation", () => {
    const markets = makeMarkets(["E1", "E2"]);
    const samples = [
      [],
      applyAllocations({
        markets,
        userId: "A",
        userAllocation: { allocations: { [markets[0].eventId]: 1 } },
        totalCapital: 100,
      }).markets,
    ];
    for (const ms of samples) {
      const r = calcAllocationLtv({ markets: ms, userId: "A" });
      expect(r.ltv).toBeGreaterThanOrEqual(POOL_LTV_FLOOR);
      expect(r.ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
    }
  });

  it("breakdown is exposed for UI (incl. new reinsurance + independence terms)", () => {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: {
          [markets[0].eventId]: 0.4,
          [markets[1].eventId]: 0.4,
          [markets[2].eventId]: 0.2,
        },
      },
      totalCapital: 1000,
    }).markets;
    const r = calcAllocationLtv({ markets, userId: "A" });
    expect(r.breakdown).toHaveProperty("floor");
    expect(r.breakdown).toHaveProperty("concentration");
    expect(r.breakdown).toHaveProperty("diversity");
    expect(r.breakdown).toHaveProperty("breadth");
    expect(r.breakdown).toHaveProperty("reinsuranceCoverage");
    expect(r.breakdown).toHaveProperty("independence");
    expect(r.breakdown).toHaveProperty("maxWeightPenalty");
  });

  it("LTV rises when reinsurance is bought (other things equal)", () => {
    const ids = ["E1", "E2", "E3", "E4"];
    let markets = makeMarkets(ids);
    const allocs = Object.fromEntries(markets.map((m) => [m.eventId, 0.25]));
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: allocs },
      totalCapital: 1000,
    }).markets;

    const before = calcAllocationLtv({ markets, userId: "A" });
    const after = calcAllocationLtv({
      markets,
      userId: "A",
      reinsurance: makeReinsuranceCovering("A", 1000),
    });
    expect(after.ltv).toBeGreaterThan(before.ltv);
    expect(after.breakdown.reinsuranceCoverage).toBeGreaterThan(
      before.breakdown.reinsuranceCoverage
    );
  });

  it("LTV rises when allocations span uncorrelated underlying pairs", () => {
    // Two configurations with the SAME number of markets and the SAME
    // even allocation, but different underlying pair-key spread.
    const ids = ["E1", "E2", "E3", "E4"];

    // Config 1: all macro (pairKey null) — independence ≈ 0.5 prior.
    let macroMarkets = makeMarkets(ids);
    macroMarkets = applyAllocations({
      markets: macroMarkets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(macroMarkets.map((m) => [m.eventId, 0.25])),
      },
      totalCapital: 1000,
    }).markets;

    // Config 2: 4 distinct pair-keys, empty corr-map → independence ≈ 1.
    const pairKeys = ["BTCUSD", "ETHUSD", "GOLD", "EURUSD"];
    let pairedMarkets = ids.map((eventId, i) =>
      makeInsuranceMarket({ eventId, pairKey: pairKeys[i], category: "pair-price" })
    );
    pairedMarkets = applyAllocations({
      markets: pairedMarkets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(pairedMarkets.map((m) => [m.eventId, 0.25])),
      },
      totalCapital: 1000,
    }).markets;

    const macroLtv = calcAllocationLtv({ markets: macroMarkets, userId: "A" });
    const pairedLtv = calcAllocationLtv({
      markets: pairedMarkets,
      userId: "A",
      correlationMap: {},
    });
    expect(pairedLtv.breakdown.independence).toBeGreaterThan(
      macroLtv.breakdown.independence
    );
    expect(pairedLtv.ltv).toBeGreaterThan(macroLtv.ltv);
  });
});

describe("calcReinsuranceCoverageRatio", () => {
  it("is 0 when there's no insurer exposure", () => {
    expect(
      calcReinsuranceCoverageRatio({
        totalInsurerExposure: 0,
        reinsurance: makeReinsuranceCovering("A", 1000),
        userId: "A",
      })
    ).toBe(0);
  });

  it("is 1 when reinsurance face × coverageFraction sums to the exposure", () => {
    expect(
      calcReinsuranceCoverageRatio({
        totalInsurerExposure: 1000,
        reinsurance: makeReinsuranceCovering("A", 1000),
        userId: "A",
      })
    ).toBeCloseTo(1.0);
  });

  it("is capped at 1", () => {
    expect(
      calcReinsuranceCoverageRatio({
        totalInsurerExposure: 1000,
        reinsurance: makeReinsuranceCovering("A", 5000),
        userId: "A",
      })
    ).toBe(1);
  });
});

describe("calcAllocationIndependence", () => {
  it("is 0 when user has no allocation", () => {
    expect(
      calcAllocationIndependence({
        markets: makeMarkets(["E1"]),
        userId: "A",
      })
    ).toBe(0);
  });

  it("is 1 for a single allocation", () => {
    let markets = makeMarkets(["E1"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1 } },
      totalCapital: 1000,
    }).markets;
    expect(calcAllocationIndependence({ markets, userId: "A" })).toBe(1);
  });

  it("collapses when two allocations share the same underlying pair", () => {
    let markets = ["E1", "E2"].map((eventId) =>
      makeInsuranceMarket({ eventId, pairKey: "BTCUSD", category: "pair-price" })
    );
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: { [markets[0].eventId]: 0.5, [markets[1].eventId]: 0.5 },
      },
      totalCapital: 1000,
    }).markets;
    expect(
      calcAllocationIndependence({ markets, userId: "A" })
    ).toBeCloseTo(0);
  });

  it("is high when allocations span distinct uncorrelated pairs", () => {
    const pairKeys = ["BTCUSD", "GOLD", "EURUSD"];
    let markets = pairKeys.map((pk, i) =>
      makeInsuranceMarket({
        eventId: `E${i}`,
        pairKey: pk,
        category: "pair-price",
      })
    );
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(markets.map((m) => [m.eventId, 1 / 3])),
      },
      totalCapital: 1500,
    }).markets;
    expect(
      calcAllocationIndependence({ markets, userId: "A", correlationMap: {} })
    ).toBeCloseTo(1, 2);
  });
});

describe("evaluateTier3Gate", () => {
  it("denies entry when no allocations", () => {
    const r = evaluateTier3Gate({
      markets: makeMarkets(["E1", "E2", "E3"]),
      userId: "A",
    });
    expect(r.open).toBe(false);
    expect(r.missing.length).toBeGreaterThan(0);
  });

  it(`denies entry when allocated to fewer than ${MIN_TIER3_MARKETS} markets`, () => {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1 } },
      totalCapital: 1000,
    }).markets;
    const r = evaluateTier3Gate({
      markets,
      userId: "A",
      reinsurance: makeReinsuranceCovering("A", 1000),
    });
    expect(r.open).toBe(false);
    expect(r.missing.some((m) => m.includes("markets"))).toBe(true);
  });

  it("denies entry when one allocation is > 50%", () => {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: {
          [markets[0].eventId]: 0.7,
          [markets[1].eventId]: 0.2,
          [markets[2].eventId]: 0.1,
        },
      },
      totalCapital: 1000,
    }).markets;
    const r = evaluateTier3Gate({
      markets,
      userId: "A",
      reinsurance: makeReinsuranceCovering("A", 1000),
    });
    expect(r.open).toBe(false);
    expect(r.missing.some((m) => m.includes("50%"))).toBe(true);
  });

  it("denies entry when no reinsurance is bought", () => {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(markets.map((m) => [m.eventId, 1 / 3])),
      },
      totalCapital: 1000,
    }).markets;
    const r = evaluateTier3Gate({ markets, userId: "A", reinsurance: [] });
    expect(r.open).toBe(false);
    expect(r.missing.some((m) => m.includes("reinsurance"))).toBe(true);
  });

  it("opens when all three conditions are met", () => {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(markets.map((m) => [m.eventId, 1 / 3])),
      },
      totalCapital: 1000,
    }).markets;
    const r = evaluateTier3Gate({
      markets,
      userId: "A",
      reinsurance: makeReinsuranceCovering("A", 1000),
    });
    expect(r.open).toBe(true);
    expect(r.missing).toEqual([]);
  });
});

describe("calcAvailableCredit", () => {
  it("returns 0 when user has no stake", () => {
    const markets = makeMarkets(["E1"]);
    expect(calcAvailableCredit({ markets, userId: "X" })).toBe(0);
  });

  it("equals stake × LTV when no credit deployed", () => {
    let markets = makeMarkets(["E1", "E2", "E3", "E4"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: {
        allocations: Object.fromEntries(markets.map((m) => [m.eventId, 0.25])),
      },
      totalCapital: 1000,
    }).markets;
    const { ltv, stats } = calcAllocationLtv({ markets, userId: "A" });
    const expected = stats.totalStake * ltv;
    expect(calcAvailableCredit({ markets, userId: "A" })).toBeCloseTo(expected);
  });

  it("never goes negative", () => {
    let markets = makeMarkets(["E1"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1 } },
      totalCapital: 100,
    }).markets;
    expect(
      calcAvailableCredit({ markets, userId: "A", deployedCredit: 1e6 })
    ).toBe(0);
  });
});

describe("isOverCreditBudget", () => {
  it("is false when nothing is deployed", () => {
    expect(
      isOverCreditBudget({
        markets: makeMarkets(["E1"]),
        userId: "A",
        deployedCredit: 0,
      })
    ).toBe(false);
  });

  it("is true when deployed credit exceeds stake × LTV", () => {
    let markets = makeMarkets(["E1"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1 } },
      totalCapital: 100,
    }).markets;
    expect(
      isOverCreditBudget({
        markets,
        userId: "A",
        deployedCredit: 1000,
      })
    ).toBe(true);
  });
});
