// Integration test: drive several medium-epoch cycles through the core
// modules end-to-end and assert that state converges and stays bounded.
//
// Phase-5 trimmed loop: price → regime → NPCs → auction → pool settle.
// Strips removed; insurance markets / reinsurance / TT redemption are
// covered by their own unit-test suites and exercised in the App-level
// useEpochLoop integration.

import { describe, it, expect } from "vitest";
import { ACTIVE_PAIRS } from "../../constants/assets.js";
import { initPairState } from "../../state/pairState.js";
import { priceStep } from "../priceModels.js";
import { calcRealizedSigma } from "../math.js";
import { detectRegime } from "../regime.js";
import { runAuction } from "../auction.js";
import { settleDominantPool } from "../pool.js";
import { applyNpcSettlement, tickNpcRestock, isNpcActive, updateNpcRegime } from "../npcs.js";
import { generateNpcOrders } from "../npcMarkets.js";
import { getEffectiveCap } from "../esma.js";

describe("integration: 10 medium epochs", () => {
  it("core modules compose without throwing or exploding state", () => {
    const pk = ACTIVE_PAIRS[0];
    let state = initPairState(pk);

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

      // Medium: regime + NPC + auction + settle
      state.regime = detectRegime(state.returnHistory);
      const regimeNpcs = state.npcs.map((n) =>
        updateNpcRegime(n, state.prices.slice(-20), state.regime, null, state.yieldModel)
      );
      const restocked = tickNpcRestock(regimeNpcs);
      const active = restocked.filter(isNpcActive);

      const { effectiveCap: cap } = getEffectiveCap(pk, state.realizedSigma);

      const auction = runAuction(
        active.map((n) => ({ ...n, base_margin: n.current_margin ?? n.base_margin })),
        state.alpha,
        [],
        cap,
        state.smileParams,
        state.realizedSigma,
        state.prevSmoothFills,
        state.metaParams
      );

      const poolUsers = active.map((n) => ({
        id: n.id,
        margin: n.current_margin ?? n.base_margin,
        leverage: Math.min(n.max_lev, cap),
        side: n.strategy?.includes("SHORT") ? "SHORT" : "LONG",
        active: true,
      }));
      const priceOld = state.prices[state.prices.length - 2];
      const priceNew = state.prices[state.prices.length - 1];
      const { users: settledUsers } = settleDominantPool(
        poolUsers, priceOld, priceNew, state.realizedSigma, {}
      );

      state.npcs = applyNpcSettlement(restocked, settledUsers);

      const npcOrders = generateNpcOrders({
        npcs: state.npcs.filter(isNpcActive),
        longMargin: auction.matched.reduce((s, m) => s + m.margin, 0),
        shortMargin: 0,
        regime: state.regime,
        normWeights: auction.normWeights,
        realizedSigma: state.realizedSigma,
        returnHistory: state.returnHistory,
        epochIndex: epoch,
      });

      // Strips removed in Phase 5; rental bids and insurance settlement
      // are tested separately. Just retain npcOrders.rentalBids for
      // shape sanity here.
      void npcOrders;

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
    expect(state.npcs.length).toBe(5);
    expect(state.npcs.every((n) => (n.current_margin ?? n.base_margin) >= 0)).toBe(true);
    expect(state.auctionResult.longCurve.length).toBeGreaterThan(0);
  });
});
