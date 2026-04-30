import { describe, it, expect } from "vitest";
import { generateNpcOrders, npcRentalBidTick } from "../npcMarkets.js";

// Note: strip-buying NPCs were removed in Phase 5. The previous
// `stripBuys`-shape and `npcStripTick` tests have been deleted.

describe("generateNpcOrders", () => {
  it("returns a rentalBids array and ignores unused inputs gracefully", () => {
    const o = generateNpcOrders({
      npcs: [
        { id: "Degen", behavior: "aggressive_long", base_margin: 2000, current_margin: 2000 },
      ],
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [0.25, 0.25, 0.25, 0.25],
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
      pairKey: "BTCUSD",
    });
    expect(o.rentalBids).toBeInstanceOf(Array);
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
