import { describe, it, expect } from "vitest";
import {
  isValidAuctionBid,
  isValidPoolUser,
  isValidRentalBid,
  filterValid,
  assertAdapter,
} from "../orderFlow.js";
import { createDefaultBotAdapter } from "../defaultBotAdapter.js";
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

describe("DefaultBotAdapter", () => {
  function fakePairState({ realizedSigma = 0.02, prices = [100, 100] } = {}) {
    return { realizedSigma, prices, returnHistory: [] };
  }

  it("produces participants and poolUsers from the legacy NPC roster", () => {
    const a = createDefaultBotAdapter({ pairKeys: ["BTCUSD"] });
    const r = a.run({
      pairKey: "BTCUSD",
      epoch: 0,
      pairState: fakePairState(),
      regime: { key: "CALM" },
      yieldModel: {},
      cap: 5,
    });
    expect(r.participants.length).toBeGreaterThan(0);
    expect(r.poolUsers.length).toBeGreaterThan(0);
    // Participants have full bid shape; pool users have minimal shape.
    expect(r.participants.every(isValidAuctionBid)).toBe(true);
    expect(r.poolUsers.every(isValidPoolUser)).toBe(true);
  });

  it("applySettlement updates internal NPC state", () => {
    const a = createDefaultBotAdapter({ pairKeys: ["BTCUSD"] });
    const r1 = a.run({
      pairKey: "BTCUSD",
      epoch: 0,
      pairState: fakePairState(),
      regime: { key: "CALM" },
      yieldModel: {},
      cap: 5,
    });
    const target = r1.poolUsers[0];
    a.applySettlement({
      pairKey: "BTCUSD",
      settledUsers: [{ id: target.id, margin: 0.0001, liquidated: true }],
    });
    const liq = a.detectLiquidationsFromSnapshot({
      pairKey: "BTCUSD",
      preSettlementSnapshot: r1.snapshot,
    });
    expect(liq.length).toBeGreaterThan(0);
    expect(liq[0].id).toBe(target.id);
  });

  it("auto-creates per-pair slot on first run for unknown pairs", () => {
    const a = createDefaultBotAdapter({ pairKeys: [] }); // no slots seeded
    const r = a.run({
      pairKey: "NEWPAIR",
      epoch: 0,
      pairState: fakePairState(),
      regime: { key: "CALM" },
      yieldModel: {},
      cap: 3,
    });
    expect(r.participants.length).toBeGreaterThan(0);
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
