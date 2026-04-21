import { describe, it, expect } from "vitest";
import {
  ROLES,
  initLedger,
  appendEpochEntry,
  epochTotal,
} from "../roleLedger.js";

describe("initLedger", () => {
  it("starts with zero cumulative across all roles", () => {
    const l = initLedger();
    for (const k of ROLES) expect(l.cumulative[k]).toBe(0);
    expect(l.lastEpoch).toBeNull();
    expect(l.history).toEqual([]);
  });
});

describe("appendEpochEntry", () => {
  it("sums per-role deltas into cumulative", () => {
    let l = initLedger();
    l = appendEpochEntry(l, { tbill: 0.5, auctionPnl: 1.2, tips: -0.1 });
    l = appendEpochEntry(l, { tbill: 0.5, auctionPnl: -0.3, tips: 0.2 });
    expect(l.cumulative.tbill).toBeCloseTo(1.0);
    expect(l.cumulative.auctionPnl).toBeCloseTo(0.9);
    expect(l.cumulative.tips).toBeCloseTo(0.1);
  });

  it("drops non-numeric fields gracefully", () => {
    let l = initLedger();
    l = appendEpochEntry(l, { tbill: "nope", auctionPnl: null, tips: NaN });
    expect(l.cumulative.tbill).toBe(0);
    expect(l.cumulative.auctionPnl).toBe(0);
    expect(l.cumulative.tips).toBe(0);
  });

  it("lastEpoch is the most recently appended entry", () => {
    let l = initLedger();
    l = appendEpochEntry(l, { tbill: 1 });
    l = appendEpochEntry(l, { tbill: 2, epoch: 42 });
    expect(l.lastEpoch.tbill).toBe(2);
    expect(l.lastEpoch.epoch).toBe(42);
  });

  it("history is ring-buffered", () => {
    let l = initLedger();
    for (let i = 0; i < 150; i++) l = appendEpochEntry(l, { tbill: 0.1 }, 120);
    expect(l.history.length).toBe(120);
  });

  it("each entry carries a total across all roles", () => {
    let l = initLedger();
    l = appendEpochEntry(l, { tbill: 1, auctionPnl: 2, tips: -0.5 });
    expect(l.lastEpoch.total).toBeCloseTo(2.5);
  });
});

describe("epochTotal", () => {
  it("returns 0 for null entry", () => {
    expect(epochTotal(null)).toBe(0);
  });
  it("sums defined role values", () => {
    expect(epochTotal({ tbill: 1, auctionPnl: 2, tips: 3 })).toBe(6);
  });
});
