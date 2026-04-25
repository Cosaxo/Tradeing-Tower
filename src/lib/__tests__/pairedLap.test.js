import { describe, it, expect } from "vitest";
import {
  makePairedLap,
  makePairedLapId,
  isPairedLap,
  calcPairedLapClosePnl,
  totalPairedMargin,
  legMargin,
  hasActiveRental,
} from "../pairedLap.js";

describe("makePairedLap", () => {
  it("produces a well-formed paired LAP", () => {
    const p = makePairedLap({
      pairKey: "BTCUSD",
      margin: 1000,
      leverage: 5,
      openPrice: 50000,
      openedAtEpoch: 7,
    });
    expect(p.type).toBe("paired");
    expect(p.pairKey).toBe("BTCUSD");
    expect(p.margin).toBe(1000);
    expect(p.leverage).toBe(5);
    expect(p.openedAtEpoch).toBe(7);
    expect(p.legs.long.rentedTo).toBeNull();
    expect(p.legs.short.rentedTo).toBeNull();
    expect(p.id).toMatch(/^PLAP-/);
  });

  it("accepts an explicit id (so callers can wire pool linkage atomically)", () => {
    const p = makePairedLap({
      pairKey: "ETHUSD",
      margin: 2000,
      leverage: 2,
      openPrice: 3000,
      id: "PLAP-test-1",
    });
    expect(p.id).toBe("PLAP-test-1");
  });
});

describe("makePairedLapId", () => {
  it("returns distinct IDs across rapid calls", () => {
    const a = makePairedLapId();
    const b = makePairedLapId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^PLAP-/);
  });
});

describe("isPairedLap", () => {
  it("recognises paired LAPs", () => {
    const p = makePairedLap({ pairKey: "BTCUSD", margin: 100, leverage: 2, openPrice: 100 });
    expect(isPairedLap(p)).toBe(true);
  });
  it("rejects single LAPs and non-positions", () => {
    expect(isPairedLap({ pairKey: "BTCUSD", side: "LONG", margin: 100 })).toBe(false);
    expect(isPairedLap(null)).toBe(false);
    expect(isPairedLap(undefined)).toBe(false);
    expect(isPairedLap({})).toBe(false);
  });
});

describe("calcPairedLapClosePnl", () => {
  const open = makePairedLap({
    pairKey: "BTCUSD",
    margin: 1000,
    leverage: 5,
    openPrice: 100,
  });

  it("net P&L is exactly zero when price is unchanged", () => {
    const { longPnl, shortPnl, netPnl } = calcPairedLapClosePnl(open, 100);
    expect(longPnl).toBe(0);
    expect(shortPnl).toBe(0);
    expect(netPnl).toBe(0);
  });

  it("legs cancel to first order on small moves; convexity (gamma) is non-negative", () => {
    const { longPnl, shortPnl, netPnl } = calcPairedLapClosePnl(open, 105);
    expect(longPnl).toBeGreaterThan(0);
    expect(shortPnl).toBeLessThan(0);
    expect(netPnl).toBeGreaterThan(0); // positive gamma
    // Order of magnitude: ~0.6% of margin for a 5% move at 5×.
    expect(netPnl / open.margin).toBeLessThan(0.02);
  });

  it("net P&L is symmetric in price direction (gamma is one-sided positive)", () => {
    const up = calcPairedLapClosePnl(open, 105).netPnl;
    const dn = calcPairedLapClosePnl(open, 100 / 1.05).netPnl;
    expect(up).toBeCloseTo(dn, 5);
  });

  it("zero or non-positive open price returns zero P&L safely", () => {
    const broken = { ...open, openPrice: 0 };
    const r = calcPairedLapClosePnl(broken, 100);
    expect(r.netPnl).toBe(0);
  });

  it("throws if called on a non-paired position", () => {
    expect(() => calcPairedLapClosePnl({ side: "LONG", margin: 100 }, 100)).toThrow();
  });
});

describe("margin helpers", () => {
  const p = makePairedLap({ pairKey: "BTCUSD", margin: 1000, leverage: 2, openPrice: 100 });

  it("totalPairedMargin returns the funded total", () => {
    expect(totalPairedMargin(p)).toBe(1000);
    expect(totalPairedMargin({ side: "LONG", margin: 1000 })).toBe(0);
  });

  it("legMargin is half of total", () => {
    expect(legMargin(p)).toBe(500);
  });
});

describe("hasActiveRental", () => {
  it("is false on a freshly-opened paired LAP", () => {
    const p = makePairedLap({ pairKey: "BTCUSD", margin: 1000, leverage: 2, openPrice: 100 });
    expect(hasActiveRental(p)).toBe(false);
  });

  it("is true if either leg shows a renter (Phase-3 forward-compat)", () => {
    const p = makePairedLap({ pairKey: "BTCUSD", margin: 1000, leverage: 2, openPrice: 100 });
    p.legs.long.rentedTo = "NPC-Whale";
    expect(hasActiveRental(p)).toBe(true);
  });
});

// Cross-module sanity checks: paired LAPs must compose cleanly with the
// existing position-list consumers (LTV, pool linkage).

import { calcPoolLtv } from "../ltv.js";
import { linkLapToDeposit, unlinkLapFromDeposit } from "../poolLinkage.js";
import { initInsurancePool } from "../insurance.js";

describe("paired LAP × LTV", () => {
  it("a paired LAP appears in calcPoolLtv as one position", () => {
    const single = { pairKey: "BTCUSD", margin: 1000, leverage: 2 };
    const paired = makePairedLap({
      pairKey: "BTCUSD",
      margin: 2000, // 2× a single LAP's margin (both legs)
      leverage: 2,
      openPrice: 100,
    });
    const ltvSingle = calcPoolLtv([single]);
    const ltvPaired = calcPoolLtv([paired]);
    expect(ltvSingle.stats.numPositions).toBe(1);
    expect(ltvPaired.stats.numPositions).toBe(1);
    // Both single and paired have HHI = 1 (one pair). Paired isn't yet
    // rewarded for delta-neutrality in LTV — that's a later refinement.
    expect(ltvPaired.stats.hhi).toBeCloseTo(1, 3);
  });

  it("a diversified book of paired LAPs gets a high LTV like one of single LAPs", () => {
    const positions = [
      makePairedLap({ pairKey: "BTCUSD", margin: 200, leverage: 1, openPrice: 100 }),
      makePairedLap({ pairKey: "EURUSD", margin: 200, leverage: 1, openPrice: 100 }),
      makePairedLap({ pairKey: "SPX500", margin: 200, leverage: 1, openPrice: 100 }),
      makePairedLap({ pairKey: "GOLD", margin: 200, leverage: 1, openPrice: 100 }),
      makePairedLap({ pairKey: "OIL", margin: 200, leverage: 1, openPrice: 100 }),
    ];
    const { ltv } = calcPoolLtv(positions);
    expect(ltv).toBeGreaterThan(0.80);
  });
});

describe("paired LAP × pool linkage", () => {
  it("a single linkage covers the whole paired LAP (both legs)", () => {
    const lapId = "PLAP-test-link";
    const paired = makePairedLap({
      pairKey: "BTCUSD",
      margin: 2000,
      leverage: 2,
      openPrice: 100,
      id: lapId,
      poolLinkage: { depositorId: "You", lapId, pairKey: "BTCUSD", creditConsumed: 2000 },
    });

    let pool = initInsurancePool();
    pool.deposits = {
      You: { amount: 5000, depositEpoch: 0, lockupRemaining: 0, linkedLaps: [], deployedCredit: 0 },
    };
    pool.totalDeposits = 5000;

    pool = linkLapToDeposit(pool, "You", lapId, paired.margin);
    expect(pool.deposits.You.deployedCredit).toBe(2000);
    expect(pool.deposits.You.linkedLaps).toHaveLength(1);

    // Unlink with no realized loss (clean close).
    pool = unlinkLapFromDeposit(pool, "You", lapId, 0);
    expect(pool.deposits.You.deployedCredit).toBe(0);
    expect(pool.deposits.You.linkedLaps).toHaveLength(0);
  });
});
