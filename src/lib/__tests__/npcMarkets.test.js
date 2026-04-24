import { describe, it, expect } from "vitest";
import { generateNpcOrders, npcStripTick } from "../npcMarkets.js";

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
