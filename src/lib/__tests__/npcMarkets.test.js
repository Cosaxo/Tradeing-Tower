import { describe, it, expect } from "vitest";
import { generateNpcOrders, npcStripTick, npcRentalBidTick } from "../npcMarkets.js";

const npcs = [
  { id: "Whale", behavior: "conservative_long", base_margin: 10000, max_lev: 2 },
  { id: "Degen", behavior: "aggressive_long", base_margin: 2000, max_lev: 5 },
  { id: "Hedger", behavior: "yield_farmer", base_margin: 7000, max_lev: 3 },
  { id: "Bot", behavior: "yield_chaser", base_margin: 5000, max_lev: 4 },
  { id: "Bear", behavior: "contrarian", base_margin: 5500, max_lev: 3 },
];

describe("generateNpcOrders", () => {
  it("returns a stripBuys array and ignores unused inputs gracefully", () => {
    const o = generateNpcOrders({
      npcs,
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [0.25, 0.25, 0.25, 0.25],
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
    });
    expect(o.stripBuys).toBeInstanceOf(Array);
  });

  it("buys strips in high-vol regime only", () => {
    const calm = generateNpcOrders({
      npcs,
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [],
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
    });
    const highVol = generateNpcOrders({
      npcs,
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "HIGH_VOL" },
      normWeights: [],
      realizedSigma: 0.08,
      returnHistory: [],
      epochIndex: 0,
    });
    expect(calm.stripBuys.length).toBe(0);
    expect(highVol.stripBuys.length).toBeGreaterThan(0);
  });
});

describe("npcStripTick", () => {
  it("skips NPCs whose behavior isn't a strip buyer", () => {
    const aggressive = { id: "Degen", behavior: "aggressive_long", base_margin: 1000 };
    expect(npcStripTick(aggressive, { key: "CRASH" }, 0.08, [])).toBeNull();
  });

  it("returns a strip for eligible behaviors in a stressed regime", () => {
    const hedger = { id: "Hedger", behavior: "yield_farmer", base_margin: 5000, max_lev: 3 };
    const strip = npcStripTick(hedger, { key: "HIGH_VOL" }, 0.05, []);
    expect(strip).toBeTruthy();
    expect(strip.id).toMatch(/^NPC-STRIP-/);
  });
});

describe("npcRentalBidTick", () => {
  it("returns null for non-renter behaviors (yield_farmer, conservative_long)", () => {
    const hedger = { id: "Hedger", behavior: "yield_farmer", base_margin: 5000, current_margin: 5000 };
    expect(npcRentalBidTick(hedger, "BTCUSD", { key: "CALM" }, 0, 1000)).toBeNull();
  });

  it("returns a bid for aggressive_long in any regime", () => {
    const degen = { id: "Degen", behavior: "aggressive_long", base_margin: 2000, current_margin: 2000 };
    const bid = npcRentalBidTick(degen, "BTCUSD", { key: "CALM" }, 0, 1000);
    expect(bid).toBeTruthy();
    expect(bid.bidderId).toBe("Degen");
    expect(bid.pairKey).toBe("BTCUSD");
    expect(bid.maxTipRate).toBeGreaterThan(0);
    expect(bid.rentalMargin).toBeGreaterThan(0);
  });

  it("aggressive bidder bids higher in trending regimes", () => {
    const degen = { id: "Degen", behavior: "aggressive_long", base_margin: 2000, current_margin: 2000 };
    const calm = npcRentalBidTick(degen, "BTCUSD", { key: "CALM" }, 0, 1000);
    const trending = npcRentalBidTick(degen, "BTCUSD", { key: "TRENDING_UP" }, 0, 1000);
    expect(trending.maxTipRate).toBeGreaterThan(calm.maxTipRate);
  });

  it("returns null when NPC margin can't cover the rental margin", () => {
    const broke = { id: "Broke", behavior: "aggressive_long", base_margin: 100, current_margin: 50 };
    expect(npcRentalBidTick(broke, "BTCUSD", { key: "CALM" }, 0, 1000)).toBeNull();
  });
});

describe("generateNpcOrders rental bids", () => {
  it("includes rentalBids when pairKey is supplied", () => {
    const o = generateNpcOrders({
      npcs: [
        { id: "Degen", behavior: "aggressive_long", base_margin: 2000, current_margin: 2000 },
        { id: "Bear",  behavior: "contrarian",     base_margin: 5500, current_margin: 5500 },
      ],
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [],
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
      pairKey: "BTCUSD",
      legNotionalEstimate: 1000,
    });
    expect(o.rentalBids.length).toBeGreaterThan(0);
  });
});
