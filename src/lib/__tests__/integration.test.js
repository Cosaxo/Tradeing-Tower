// Integration test: drive several medium-epoch cycles through the core
// modules end-to-end and assert that state stays bounded and the auction
// short-circuits cleanly with no counterparty flow attached.
//
// Phase-6 trimmed loop: price → regime → adapter-flow → auction → pool
// settle. Synthetic NPC counterparties were removed when the project
// repositioned as a real-flow clearinghouse engine; counterparty flow is
// now expected from an OrderFlowAdapter (src/lib/orderFlow.js). This
// smoke test runs with the NULL adapter so only the local "player"
// participates — the auction must produce a well-formed empty result.

import { describe, it, expect } from "vitest";
import { ACTIVE_PAIRS } from "../../constants/assets.js";
import { initPairState } from "../../state/pairState.js";
import { priceStep } from "../priceModels.js";
import { calcRealizedSigma } from "../math.js";
import { detectRegime } from "../regime.js";
import { runAuction } from "../auction.js";
import { settleDominantPool } from "../pool.js";
import { getEffectiveCap } from "../esma.js";
import { NULL_ORDER_FLOW_ADAPTER, getBids, getPoolUsers } from "../orderFlow.js";

describe("integration: 10 medium epochs (NULL order flow)", () => {
  it("core modules compose without throwing or exploding state", () => {
    const pk = ACTIVE_PAIRS[0];
    let state = initPairState(pk);

    const player = {
      id: "You",
      strategy: "FIXED_LONG",
      base_margin: 5000,
      max_lev: 2.0,
      tip_tiers: [{ lev_start: 1.0, lev_end: 2.0, tip: 0.02 }],
    };

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

      state.regime = detectRegime(state.returnHistory);
      const { effectiveCap: cap } = getEffectiveCap(pk, state.realizedSigma);

      const ctx = {
        pairKey: pk,
        currentEpoch: epoch,
        regime: state.regime,
        realizedSigma: state.realizedSigma,
        cap,
      };
      const externalBids = getBids(NULL_ORDER_FLOW_ADAPTER, ctx);
      const externalPool = getPoolUsers(NULL_ORDER_FLOW_ADAPTER, ctx);

      const participants = [...externalBids, { ...player, max_lev: Math.min(player.max_lev, cap) }];

      const auction = runAuction(
        participants,
        state.alpha,
        [],
        cap,
        state.smileParams,
        state.realizedSigma,
        state.prevSmoothFills,
        state.metaParams
      );

      const poolUsers = [
        ...externalPool,
        {
          id: player.id,
          margin: player.base_margin,
          leverage: Math.min(player.max_lev, cap),
          side: "LONG",
          active: true,
        },
      ];
      const priceOld = state.prices[state.prices.length - 2];
      const priceNew = state.prices[state.prices.length - 1];
      const { users: settledUsers } = settleDominantPool(
        poolUsers, priceOld, priceNew, state.realizedSigma, {}
      );

      state.auctionResult = auction;
      state.smileParams = auction.smileParams;
      state.metaParams = auction.metaParams;
      state.prevSmoothFills = auction.smoothFills;
      state.epochIndex = epoch + 1;

      // With only one participant, the auction can't clear; just assert
      // settlement returns a valid array of the size we put in.
      expect(settledUsers.length).toBe(poolUsers.length);
    }

    // Invariants:
    expect(state.prices.length).toBeGreaterThan(5);
    expect(state.prices.every((p) => p > 0)).toBe(true);
    expect(state.realizedSigma).toBeGreaterThanOrEqual(0);
    expect(state.realizedSigma).toBeLessThan(1);
    // Empty book → zero matches, well-formed result.
    expect(state.auctionResult.totalMatched).toBe(0);
    expect(state.auctionResult).toMatchObject({
      matched: [],
      longCurve: [],
      shortCurve: [],
    });
  });
});
