import { describe, it, expect } from "vitest";
import {
  makeLapId,
  linkLapToDeposit,
  unlinkLapFromDeposit,
  applyPoolToLapHaircut,
  applyLapToPoolHaircut,
  queuePoolToLapHaircut,
} from "../poolLinkage.js";
import { initInsurancePool } from "../insurance.js";

function poolWithDeposit(id = "You", amount = 1000) {
  const pool = initInsurancePool();
  pool.deposits[id] = {
    amount,
    depositEpoch: 0,
    lockupRemaining: 0,
    linkedLaps: [],
    deployedCredit: 0,
  };
  pool.totalDeposits = amount;
  return pool;
}

describe("linkLapToDeposit", () => {
  it("registers a new LAP and increments deployedCredit", () => {
    const pool = poolWithDeposit();
    const next = linkLapToDeposit(pool, "You", "LAP-1", 500);
    expect(next.deposits.You.linkedLaps).toHaveLength(1);
    expect(next.deposits.You.linkedLaps[0]).toMatchObject({ lapId: "LAP-1", creditConsumed: 500 });
    expect(next.deposits.You.deployedCredit).toBe(500);
  });

  it("no-ops when depositor doesn't exist", () => {
    const pool = poolWithDeposit();
    const next = linkLapToDeposit(pool, "Nobody", "LAP-1", 500);
    expect(next).toBe(pool);
  });
});

describe("unlinkLapFromDeposit", () => {
  it("removes the linkage and reduces deployedCredit", () => {
    let pool = poolWithDeposit();
    pool = linkLapToDeposit(pool, "You", "LAP-1", 500);
    pool = linkLapToDeposit(pool, "You", "LAP-2", 300);
    const next = unlinkLapFromDeposit(pool, "You", "LAP-1", 0);
    expect(next.deposits.You.linkedLaps).toHaveLength(1);
    expect(next.deposits.You.linkedLaps[0].lapId).toBe("LAP-2");
    expect(next.deposits.You.deployedCredit).toBe(300);
  });

  it("queues a pool haircut when the LAP realized a loss", () => {
    let pool = poolWithDeposit();
    pool = linkLapToDeposit(pool, "You", "LAP-1", 500);
    const next = unlinkLapFromDeposit(pool, "You", "LAP-1", 0.5); // 50% loss
    // Share of credit is 500/500 = 1.0, so queued = 0.5 × 1.0 = 0.5
    expect(next.pendingPoolHaircutPct.You).toBeCloseTo(0.5);
  });

  it("compound-merges queued haircuts on repeat losses", () => {
    let pool = poolWithDeposit();
    pool = linkLapToDeposit(pool, "You", "LAP-1", 500);
    pool = linkLapToDeposit(pool, "You", "LAP-2", 500);
    let next = unlinkLapFromDeposit(pool, "You", "LAP-1", 0.5); // queues 0.5 × 0.5 = 0.25
    next = unlinkLapFromDeposit(next, "You", "LAP-2", 0.5);     // queues another on top
    // After first: 0.25. After second: 1 - (1 - 0.25)(1 - (0.5 × 500/500)) = 1 - 0.75×0.5 = 0.625
    expect(next.pendingPoolHaircutPct.You).toBeCloseTo(0.625, 2);
  });
});

describe("queuePoolToLapHaircut + applyPoolToLapHaircut", () => {
  it("applies the queued pct uniformly to all linked positions, then clears the queue", () => {
    let pool = poolWithDeposit();
    pool = queuePoolToLapHaircut(pool, "You", 0.2);
    const positions = [
      { pairKey: "BTCUSD", margin: 1000, poolLinkage: { depositorId: "You", lapId: "A" } },
      { pairKey: "EURUSD", margin: 500, poolLinkage: { depositorId: "You", lapId: "B" } },
      { pairKey: "GOLD", margin: 2000 }, // not pool-backed
    ];
    const { positions: next, pool: nextPool } = applyPoolToLapHaircut(pool, positions);
    expect(next[0].margin).toBeCloseTo(800);  // 1000 × 0.8
    expect(next[1].margin).toBeCloseTo(400);  // 500 × 0.8
    expect(next[2].margin).toBe(2000);        // untouched
    expect(nextPool.pendingLapHaircutPct.You).toBeUndefined();
  });

  it("is a no-op when the queue is empty", () => {
    const pool = poolWithDeposit();
    const positions = [{ pairKey: "BTCUSD", margin: 1000 }];
    const { positions: next, pool: nextPool } = applyPoolToLapHaircut(pool, positions);
    expect(next).toBe(positions);
    expect(nextPool).toBe(pool);
  });
});

describe("applyLapToPoolHaircut", () => {
  it("reduces the depositor's amount and clears the queue", () => {
    let pool = poolWithDeposit("You", 1000);
    pool = { ...pool, pendingPoolHaircutPct: { You: 0.3 } };
    const next = applyLapToPoolHaircut(pool);
    expect(next.deposits.You.amount).toBeCloseTo(700);
    expect(next.totalDeposits).toBeCloseTo(700);
    expect(next.pendingPoolHaircutPct).toEqual({});
  });

  it("is a no-op when no haircuts are queued", () => {
    const pool = poolWithDeposit();
    const next = applyLapToPoolHaircut(pool);
    expect(next).toBe(pool);
  });
});

describe("makeLapId", () => {
  it("returns a string prefixed as requested", () => {
    const id = makeLapId("TEST");
    expect(typeof id).toBe("string");
    expect(id.startsWith("TEST-")).toBe(true);
  });

  it("produces distinct IDs on rapid calls", () => {
    const a = makeLapId();
    const b = makeLapId();
    expect(a).not.toBe(b);
  });
});
