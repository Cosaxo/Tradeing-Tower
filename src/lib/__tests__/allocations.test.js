import { describe, it, expect } from "vitest";
import {
  initAllocationsState,
  getUserAllocation,
  setUserAllocation,
  applyAllocations,
  propagateLapPnl,
  allocationDiversificationStats,
} from "../allocations.js";
import { makeInsuranceMarket } from "../insuranceMarket.js";

function makeMarkets(eventIds) {
  return eventIds.map((eventId) =>
    makeInsuranceMarket({ eventId, pairKey: null, category: "macro" })
  );
}

// ---------------------------------------------------------------------------
// state helpers
// ---------------------------------------------------------------------------

describe("initAllocationsState / getUserAllocation", () => {
  it("starts empty", () => {
    const s = initAllocationsState();
    expect(s.byUser).toEqual({});
    const u = getUserAllocation(s, "Alice");
    expect(u.allocations).toEqual({});
    expect(u.version).toBe(0);
  });
});

describe("setUserAllocation", () => {
  it("accepts pct in [0,1] summing ≤ 1", () => {
    let s = initAllocationsState();
    const r = setUserAllocation(s, "A", { M1: 0.5, M2: 0.3, M3: 0.2 });
    expect(r.ok).toBe(true);
    expect(getUserAllocation(r.allocations, "A").version).toBe(1);
    expect(getUserAllocation(r.allocations, "A").allocations.M1).toBe(0.5);
  });

  it("rejects sums > 1", () => {
    const s = initAllocationsState();
    const r = setUserAllocation(s, "A", { M1: 0.6, M2: 0.5 });
    expect(r.ok).toBe(false);
  });

  it("rejects out-of-range entries", () => {
    const s = initAllocationsState();
    expect(setUserAllocation(s, "A", { M1: -0.1 }).ok).toBe(false);
    expect(setUserAllocation(s, "A", { M1: 1.5 }).ok).toBe(false);
  });

  it("bumps version on each declaration", () => {
    let s = initAllocationsState();
    s = setUserAllocation(s, "A", { M1: 0.5 }).allocations;
    s = setUserAllocation(s, "A", { M1: 0.7 }).allocations;
    s = setUserAllocation(s, "A", { M1: 0.7, M2: 0.2 }).allocations;
    expect(getUserAllocation(s, "A").version).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// applyAllocations — materialization
// ---------------------------------------------------------------------------

describe("applyAllocations", () => {
  it("posts insurer stakes matching pct × totalCapital", () => {
    const markets = makeMarkets(["E1", "E2", "E3"]);
    const userAllocation = {
      allocations: {
        [markets[0].eventId]: 0.5,
        [markets[1].eventId]: 0.3,
        [markets[2].eventId]: 0.2,
      },
    };
    const out = applyAllocations({
      markets,
      userId: "A",
      userAllocation,
      totalCapital: 1000,
    });
    expect(out.markets[0].insurerPositions.A).toBeCloseTo(500);
    expect(out.markets[1].insurerPositions.A).toBeCloseTo(300);
    expect(out.markets[2].insurerPositions.A).toBeCloseTo(200);
  });

  it("redirects from old to new on rebalance", () => {
    let markets = makeMarkets(["E1", "E2"]);
    let userAllocation = {
      allocations: { [markets[0].eventId]: 1.0 },
    };
    let out = applyAllocations({
      markets,
      userId: "A",
      userAllocation,
      totalCapital: 1000,
    });
    expect(out.markets[0].insurerPositions.A).toBe(1000);

    // Now rebalance to 50/50
    userAllocation = {
      allocations: { [out.markets[0].eventId]: 0.5, [out.markets[1].eventId]: 0.5 },
    };
    out = applyAllocations({
      markets: out.markets,
      userId: "A",
      userAllocation,
      totalCapital: 1000,
    });
    expect(out.markets[0].insurerPositions.A).toBeCloseTo(500);
    expect(out.markets[1].insurerPositions.A).toBeCloseTo(500);
  });
});

// ---------------------------------------------------------------------------
// LAP P&L propagation
// ---------------------------------------------------------------------------

describe("propagateLapPnl", () => {
  function setup() {
    let markets = makeMarkets(["E1", "E2", "E3"]);
    const userAllocation = {
      allocations: {
        [markets[0].eventId]: 0.5,
        [markets[1].eventId]: 0.3,
        [markets[2].eventId]: 0.2,
      },
    };
    const r = applyAllocations({
      markets,
      userId: "A",
      userAllocation,
      totalCapital: 1000,
    });
    return r.markets;
  }

  it("gains grow each stake pro-rata to current allocation", () => {
    const markets = setup();
    const r = propagateLapPnl({ markets, userId: "A", lapPnl: 100 });
    // Stakes are 500 / 300 / 200 = 5/3/2 by weight.
    // Gain 100 distributed: 50 / 30 / 20.
    expect(r.markets[0].insurerPositions.A).toBeCloseTo(550);
    expect(r.markets[1].insurerPositions.A).toBeCloseTo(330);
    expect(r.markets[2].insurerPositions.A).toBeCloseTo(220);
    expect(r.applied).toBeCloseTo(100);
    expect(r.residual).toBe(0);
  });

  it("losses shrink each stake pro-rata", () => {
    const markets = setup();
    const r = propagateLapPnl({ markets, userId: "A", lapPnl: -200 });
    // 200/1000 = 20% loss across the board.
    expect(r.markets[0].insurerPositions.A).toBeCloseTo(400);
    expect(r.markets[1].insurerPositions.A).toBeCloseTo(240);
    expect(r.markets[2].insurerPositions.A).toBeCloseTo(160);
    expect(r.applied).toBeCloseTo(-200);
  });

  it("losses larger than total stake floor at -100%, residual reported", () => {
    const markets = setup(); // total stake 1000
    const r = propagateLapPnl({ markets, userId: "A", lapPnl: -1500 });
    expect(r.applied).toBeCloseTo(-1000);
    expect(r.residual).toBeCloseTo(-500);
    // Stakes wiped to 0
    expect(r.markets.every((m) => (m.insurerPositions.A ?? 0) === 0)).toBe(true);
  });

  it("user with no stake: residual = full lapPnl", () => {
    const markets = makeMarkets(["E1", "E2"]);
    const r = propagateLapPnl({ markets, userId: "Stranger", lapPnl: 500 });
    expect(r.applied).toBe(0);
    expect(r.residual).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// diversification stats
// ---------------------------------------------------------------------------

describe("allocationDiversificationStats", () => {
  it("returns floor stats when user has no stake", () => {
    const markets = makeMarkets(["E1", "E2", "E3"]);
    const s = allocationDiversificationStats({ markets, userId: "Stranger" });
    expect(s.numMarkets).toBe(0);
    expect(s.hhi).toBe(1);
    expect(s.maxWeight).toBe(1);
    expect(s.totalStake).toBe(0);
  });

  it("computes HHI and max-weight correctly for evenly-spread allocation", () => {
    let markets = makeMarkets(["E1", "E2", "E3", "E4"]);
    const userAllocation = {
      allocations: {
        [markets[0].eventId]: 0.25,
        [markets[1].eventId]: 0.25,
        [markets[2].eventId]: 0.25,
        [markets[3].eventId]: 0.25,
      },
    };
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation,
      totalCapital: 1000,
    }).markets;
    const s = allocationDiversificationStats({ markets, userId: "A" });
    expect(s.numMarkets).toBe(4);
    expect(s.hhi).toBeCloseTo(0.25);
    expect(s.maxWeight).toBeCloseTo(0.25);
    expect(s.totalStake).toBeCloseTo(1000);
  });

  it("HHI = 1 for fully concentrated allocation", () => {
    let markets = makeMarkets(["E1", "E2"]);
    markets = applyAllocations({
      markets,
      userId: "A",
      userAllocation: { allocations: { [markets[0].eventId]: 1.0 } },
      totalCapital: 1000,
    }).markets;
    const s = allocationDiversificationStats({ markets, userId: "A" });
    expect(s.hhi).toBeCloseTo(1);
    expect(s.maxWeight).toBeCloseTo(1);
  });
});
