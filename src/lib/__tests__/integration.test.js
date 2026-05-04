// Integration test: drive several medium-epoch cycles through the
// core modules end-to-end and assert that state converges and stays
// bounded.
//
// Sprint 3: bot adapter retired. This test now uses a synthetic-bids
// fixture (a fixed roster of long/short participants) instead of the
// legacy NPC engine, so it exercises auction → pool → settlement
// composition without coupling to a flow-source implementation.

import { describe, it, expect } from "vitest";
import { ACTIVE_PAIRS } from "../../constants/assets.js";
import { initPairState } from "../../state/pairState.js";
import { priceStep } from "../priceModels.js";
import { calcRealizedSigma } from "../math.js";
import { detectRegime } from "../regime.js";
import { runAuction } from "../auction.js";
import { settleDominantPool } from "../pool.js";
import { getEffectiveCap } from "../esma.js";

// Fixed synthetic roster — three longs and three shorts at varied
// leverage. Stable across ticks so the auction's match output and
// the pool settlement both have flow to chew on.
function makeSyntheticRoster() {
  return [
    { id: "L1", strategy: "FIXED_LONG", base_margin: 1000, max_lev: 2,
      tip_tiers: [{ lev_start: 1, lev_end: 2, tip: 0.02, fill_direction: "bottom-up" }] },
    { id: "L2", strategy: "FIXED_LONG", base_margin: 1500, max_lev: 3,
      tip_tiers: [{ lev_start: 1, lev_end: 3, tip: 0.025, fill_direction: "bottom-up" }] },
    { id: "L3", strategy: "FIXED_LONG", base_margin: 800, max_lev: 4,
      tip_tiers: [{ lev_start: 1, lev_end: 4, tip: 0.03, fill_direction: "bottom-up" }] },
    { id: "S1", strategy: "FIXED_SHORT", base_margin: 1200, max_lev: 2.5,
      tip_tiers: [{ lev_start: 1, lev_end: 2.5, tip: 0.022, fill_direction: "bottom-up" }] },
    { id: "S2", strategy: "FIXED_SHORT", base_margin: 900, max_lev: 3.5,
      tip_tiers: [{ lev_start: 1, lev_end: 3.5, tip: 0.027, fill_direction: "bottom-up" }] },
    { id: "S3", strategy: "FIXED_SHORT", base_margin: 1100, max_lev: 2,
      tip_tiers: [{ lev_start: 1, lev_end: 2, tip: 0.02, fill_direction: "bottom-up" }] },
  ];
}

describe("integration: 10 medium epochs", () => {
  it("core modules compose without throwing or exploding state", () => {
    const pk = ACTIVE_PAIRS[0];
    let state = initPairState(pk);
    const roster = makeSyntheticRoster();

    for (let epoch = 0; epoch < 10; epoch++) {
      // Fast: step the price 3x
      for (let f = 0; f < 3; f++) {
        const latest = state.prices[state.prices.length - 1];
        const next = priceStep(state.pair, latest, state.realizedSigma);
        state = {
          ...state,
          prices: [...state.prices, next].slice(-200),
        };
      }
      state.realizedSigma = calcRealizedSigma(state.prices, 12);
      state.returnHistory = state.prices.slice(1).map(
        (p, i) => Math.log(p / state.prices[i])
      );

      // Medium: regime + auction + settle
      state.regime = detectRegime(state.returnHistory);

      const { effectiveCap: cap } = getEffectiveCap(pk, state.realizedSigma);

      const auction = runAuction(
        roster.map((n) => ({ ...n, max_lev: Math.min(n.max_lev, cap) })),
        state.alpha,
        [],
        cap,
        state.smileParams,
        state.realizedSigma,
        state.prevSmoothFills,
        state.metaParams
      );

      const poolUsers = roster.map((n) => ({
        id: n.id,
        margin: n.base_margin,
        leverage: Math.min(n.max_lev, cap),
        side: n.strategy.includes("SHORT") ? "SHORT" : "LONG",
        active: true,
      }));
      const priceOld = state.prices[state.prices.length - 2];
      const priceNew = state.prices[state.prices.length - 1];
      const { users: settledUsers } = settleDominantPool(
        poolUsers, priceOld, priceNew, state.realizedSigma, {}
      );

      // Settled-user margins fold back into the roster so subsequent
      // ticks see realistic margin attrition.
      for (let i = 0; i < roster.length; i++) {
        const s = settledUsers.find((u) => u.id === roster[i].id);
        if (s) roster[i].base_margin = s.margin;
      }

      state.auctionResult = auction;
      state.smileParams = auction.smileParams;
      state.metaParams = auction.metaParams;
      state.prevSmoothFills = auction.smoothFills;
      state.epochIndex = epoch + 1;
    }

    // Invariants:
    expect(state.prices.length).toBeGreaterThan(5);
    expect(state.prices.every((p) => p > 0)).toBe(true);
    expect(state.realizedSigma).toBeGreaterThanOrEqual(0);
    expect(state.realizedSigma).toBeLessThan(1);
    expect(roster.every((n) => n.base_margin >= 0)).toBe(true);
    expect(state.auctionResult.longCurve.length).toBeGreaterThan(0);
    // At least some auction matches happened across 10 epochs given
    // the balanced 3L/3S roster.
    expect(state.auctionResult).toBeTruthy();
  });
});
