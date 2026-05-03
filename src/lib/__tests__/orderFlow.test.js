import { describe, it, expect } from "vitest";
import {
  isValidAuctionBid,
  isValidPoolUser,
  isValidRentalBid,
  filterValid,
  assertAdapter,
} from "../orderFlow.js";
import {
  createLocalBroadcastAdapter,
  getOrCreateTabUserId,
} from "../localBroadcastAdapter.js";
import { createReplayAdapter } from "../replayAdapter.js";
import { createBrokerAdapter } from "../brokerAdapter.js";

describe("schema guards", () => {
  it("isValidAuctionBid accepts well-formed bids", () => {
    expect(
      isValidAuctionBid({
        id: "Whale",
        strategy: "FIXED_LONG",
        base_margin: 12000,
        max_lev: 3,
        tip_tiers: [],
      })
    ).toBe(true);
  });

  it("isValidAuctionBid rejects missing or bad fields", () => {
    expect(isValidAuctionBid(null)).toBe(false);
    expect(isValidAuctionBid({})).toBe(false);
    expect(isValidAuctionBid({ id: "X", strategy: "Y", base_margin: -1, max_lev: 1 })).toBe(false);
    expect(isValidAuctionBid({ id: "X", strategy: "Y", base_margin: 1, max_lev: 0 })).toBe(false);
    expect(isValidAuctionBid({ id: "", strategy: "Y", base_margin: 1, max_lev: 1 })).toBe(false);
    expect(isValidAuctionBid({ id: "X", strategy: "Y", base_margin: 1, max_lev: 1, tip_tiers: "nope" })).toBe(false);
  });

  it("isValidPoolUser accepts well-formed users and rejects bad sides", () => {
    expect(isValidPoolUser({ id: "U", margin: 100, leverage: 2, side: "LONG" })).toBe(true);
    expect(isValidPoolUser({ id: "U", margin: 100, leverage: 2, side: "SHORT" })).toBe(true);
    expect(isValidPoolUser({ id: "U", margin: 100, leverage: 2, side: "FLAT" })).toBe(false);
    expect(isValidPoolUser({ id: "U", margin: -1, leverage: 2, side: "LONG" })).toBe(false);
  });

  it("isValidRentalBid checks the minimum required shape", () => {
    expect(
      isValidRentalBid({
        id: "B-1",
        bidderId: "U",
        pairKey: "BTCUSD",
        maxTipRate: 0.01,
        rentalMargin: 200,
      })
    ).toBe(true);
    expect(isValidRentalBid({ id: "B-1", bidderId: "U", pairKey: "BTCUSD", maxTipRate: 0.01 })).toBe(false);
  });

  it("filterValid splits valid and dropped lists", () => {
    const r = filterValid(
      [
        { id: "good", strategy: "X", base_margin: 1, max_lev: 1 },
        { id: "", strategy: "X", base_margin: 1, max_lev: 1 },
        null,
      ],
      isValidAuctionBid
    );
    expect(r.valid).toHaveLength(1);
    expect(r.dropped).toHaveLength(2);
  });
});

describe("assertAdapter", () => {
  it("passes for valid adapter shape", () => {
    const ok = { run() {}, applySettlement() {} };
    expect(assertAdapter(ok)).toBe(ok);
  });

  it("throws on missing methods", () => {
    expect(() => assertAdapter({})).toThrow(/missing required method/);
    expect(() => assertAdapter({ run: () => {} })).toThrow(/applySettlement/);
  });
});

describe("LocalBroadcastAdapter", () => {
  it("falls back to a null adapter when BroadcastChannel is unavailable", () => {
    // Vitest's default jsdom env doesn't ship BroadcastChannel — the
    // factory should detect this and return a degraded but valid adapter.
    const a = createLocalBroadcastAdapter({ tabUserId: "test-tab-1" });
    expect(() => assertAdapter(a)).not.toThrow();
    const r = a.run({ pairKey: "BTCUSD", cap: 3 });
    expect(r.participants).toEqual([]);
    expect(r.poolUsers).toEqual([]);
    expect(a.getPeerCount()).toBe(0);
  });

  it("returns the same adapter shape regardless of availability", () => {
    const a = createLocalBroadcastAdapter({ tabUserId: "test-tab-2" });
    expect(typeof a.run).toBe("function");
    expect(typeof a.applySettlement).toBe("function");
    expect(typeof a.markRestockedFromSnapshot).toBe("function");
    expect(typeof a.detectLiquidationsFromSnapshot).toBe("function");
    expect(typeof a.getSnapshot).toBe("function");
    expect(typeof a.getPeerCount).toBe("function");
    expect(typeof a.dispose).toBe("function");
  });

  it("dispose is idempotent", () => {
    const a = createLocalBroadcastAdapter({ tabUserId: "test-tab-3" });
    expect(() => a.dispose()).not.toThrow();
    expect(() => a.dispose()).not.toThrow();
  });
});

describe("getOrCreateTabUserId", () => {
  it("returns a string id", () => {
    const id = getOrCreateTabUserId("Alice");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("uses the supplied prefix when sessionStorage is empty", () => {
    // First call seeds sessionStorage; subsequent calls return the
    // cached value regardless of prefix. The prefix is only honoured
    // on first generation, so this assertion only holds before any
    // other call has seeded the cache.
    if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
      return;
    }
    window.sessionStorage.removeItem("tt.tabUserId");
    const id = getOrCreateTabUserId("Bob");
    expect(id.startsWith("Bob-")).toBe(true);
  });
});

describe("ReplayAdapter", () => {
  it("emits the matching frame for (epoch, pairKey)", () => {
    const tape = [
      {
        epoch: 0,
        pairKey: "BTCUSD",
        participants: [{ id: "tape-1", strategy: "FIXED_LONG", base_margin: 100, max_lev: 2 }],
        poolUsers: [{ id: "tape-1", margin: 100, leverage: 2, side: "LONG" }],
        rentalBids: [],
      },
    ];
    const a = createReplayAdapter({ tape });
    const r = a.run({ pairKey: "BTCUSD", epoch: 0 });
    expect(r.participants).toHaveLength(1);
    expect(r.poolUsers).toHaveLength(1);
    expect(r.participants[0].id).toBe("tape-1");
  });

  it("returns empty flow for missing frames", () => {
    const a = createReplayAdapter({ tape: [] });
    const r = a.run({ pairKey: "BTCUSD", epoch: 5 });
    expect(r.participants).toEqual([]);
    expect(r.poolUsers).toEqual([]);
    expect(r.rentalBids).toEqual([]);
  });

  it("filters out malformed entries even if the tape contains them", () => {
    const tape = [
      {
        epoch: 0,
        pairKey: "BTCUSD",
        participants: [
          { id: "good", strategy: "X", base_margin: 100, max_lev: 1 },
          { id: "", strategy: "X", base_margin: 100, max_lev: 1 }, // bad id
        ],
      },
    ];
    const a = createReplayAdapter({ tape });
    const r = a.run({ pairKey: "BTCUSD", epoch: 0 });
    expect(r.participants).toHaveLength(1);
    expect(r.participants[0].id).toBe("good");
  });

  it("applySettlement is a no-op (replay is read-only)", () => {
    const a = createReplayAdapter({ tape: [] });
    expect(() => a.applySettlement({ pairKey: "X", settledUsers: [] })).not.toThrow();
  });
});

describe("BrokerAdapter stub", () => {
  it("conforms to the adapter shape but throws on run/applySettlement", () => {
    const a = createBrokerAdapter();
    expect(() => assertAdapter(a)).not.toThrow();
    expect(() => a.run({})).toThrow(/not implemented/);
    expect(() => a.applySettlement({})).toThrow(/not implemented/);
  });
});
