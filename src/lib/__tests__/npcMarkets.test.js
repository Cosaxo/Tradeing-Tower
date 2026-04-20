import { describe, it, expect } from "vitest";
import { generateNpcOrders } from "../npcMarkets.js";

const npcs = [
  { id: "Whale", behavior: "conservative_long", base_margin: 10000, max_lev: 2 },
  { id: "Degen", behavior: "aggressive_long", base_margin: 2000, max_lev: 5 },
  { id: "Hedger", behavior: "yield_farmer", base_margin: 7000, max_lev: 3 },
  { id: "Bot", behavior: "yield_chaser", base_margin: 5000, max_lev: 4 },
  { id: "Bear", behavior: "contrarian", base_margin: 5500, max_lev: 3 },
];

describe("generateNpcOrders", () => {
  it("returns four arrays", () => {
    const o = generateNpcOrders({
      npcs,
      existingOffers: [],
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [0.25, 0.25, 0.25, 0.25],
      avgEntropyMult: 1,
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
    });
    expect(o.offers).toBeInstanceOf(Array);
    expect(o.imbalanceBuys).toBeInstanceOf(Array);
    expect(o.entropyBuys).toBeInstanceOf(Array);
    expect(o.stripBuys).toBeInstanceOf(Array);
  });

  it("produces lending offers only from lending behaviors", () => {
    const o = generateNpcOrders({
      npcs,
      existingOffers: [],
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [0.25, 0.25, 0.25, 0.25],
      avgEntropyMult: 1,
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
    });
    const lenderBehaviors = o.offers.map(
      (off) => npcs.find((n) => n.id === off.lenderId)?.behavior
    );
    for (const b of lenderBehaviors) {
      expect(["conservative_long", "yield_farmer", "yield_chaser"]).toContain(b);
    }
  });

  it("doesn't duplicate lending offers when NPC already has one", () => {
    const existing = [
      { id: "x", lenderId: "Whale", active: true, remaining: 500, rate: 0.003 },
    ];
    const o = generateNpcOrders({
      npcs,
      existingOffers: existing,
      longMargin: 5000,
      shortMargin: 5000,
      regime: { key: "CALM" },
      normWeights: [0.25, 0.25, 0.25, 0.25],
      avgEntropyMult: 1,
      realizedSigma: 0.02,
      returnHistory: [],
      epochIndex: 0,
    });
    expect(o.offers.find((off) => off.lenderId === "Whale")).toBeUndefined();
  });

  it("buys strips in high-vol regime only", () => {
    const calm = generateNpcOrders({
      npcs, existingOffers: [], longMargin: 5000, shortMargin: 5000,
      regime: { key: "CALM" }, normWeights: [0.25, 0.25, 0.25, 0.25],
      avgEntropyMult: 1, realizedSigma: 0.02, returnHistory: [], epochIndex: 0,
    });
    const highVol = generateNpcOrders({
      npcs, existingOffers: [], longMargin: 5000, shortMargin: 5000,
      regime: { key: "HIGH_VOL" }, normWeights: [0.25, 0.25, 0.25, 0.25],
      avgEntropyMult: 1, realizedSigma: 0.08, returnHistory: [], epochIndex: 0,
    });
    expect(calm.stripBuys.length).toBe(0);
    expect(highVol.stripBuys.length).toBeGreaterThan(0);
  });
});
