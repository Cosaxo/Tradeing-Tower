import { describe, it, expect } from "vitest";
import {
  calcAllocationLtv,
  calcAvailableCredit,
  isOverCreditBudget,
  POOL_LTV_FLOOR,
  POOL_LTV_CEILING,
} from "../ltv.js";
import { makeInsuranceMarket } from "../insuranceMarket.js";
import { applyAllocations } from "../allocations.js";

function makeMarkets(eventIds) {
  return eventIds.map((eventId) =>
    makeInsuranceMarket({ eventId, pairKey: null, category: "macro" })
  );
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
    // hhi=1, maxWeight=1, breadth=1/2=0.5, diversity=0
    // concentration component = 0; max-weight penalty = 0.20 × (0.5/0.5) = 0.20
    // breadth = 0.20 × 0.5 = 0.10
    // raw = 0.30 + 0 + 0 + 0.10 - 0.20 = 0.20 → floored to 0.30
    expect(r.ltv).toBe(POOL_LTV_FLOOR);
  });

  it("rises with even allocation across multiple markets", () => {
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
    expect(r.ltv).toBeGreaterThan(0.7);
    expect(r.ltv).toBeLessThanOrEqual(POOL_LTV_CEILING);
  });

  it("approaches the ceiling for a perfectly broad allocation", () => {
    const ids = ["E1", "E2", "E3", "E4", "E5", "E6", "E7", "E8"];
    let markets = makeMarkets(ids);
    const allocs = {};
    for (const m of markets) allocs[m.eventId] = 1 / ids.length;
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: allocs },
      totalCapital: 8000,
    }).markets;
    const r = calcAllocationLtv({ markets, userId: "A" });
    expect(r.ltv).toBeCloseTo(POOL_LTV_CEILING, 1);
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

  it("breakdown is exposed for UI", () => {
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
    expect(r.breakdown).toHaveProperty("maxWeightPenalty");
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
