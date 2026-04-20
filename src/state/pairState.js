// Per-pair simulation state factory.
// Each active pair carries its own price history, auction state,
// NPC book, regime tracker, and insurance pool slice.

import { PAIRS } from "../constants/assets.js";
import { buildNpcs } from "../lib/npcs.js";
import { initInsurancePool } from "../lib/insurance.js";
import { MAX_HISTORY } from "../constants/system.js";

export function initPairState(pairKey) {
  const pair = PAIRS[pairKey];
  if (!pair) throw new Error(`Unknown pair: ${pairKey}`);

  const initialSigma = pair.sigma;

  return {
    pairKey,
    pair,

    // Price history (ring buffer capped at MAX_HISTORY).
    prices: [pair.startPrice],
    returnHistory: [],
    realizedSigma: initialSigma,

    // Auction state.
    auctionResult: null,
    smileParams: { sk: 0, ek: 0 },
    metaParams: { muLow: 0, alpha: 0.5 },
    prevSmoothFills: null,
    alpha: 0.5, // long/short ratio

    // NPC participants.
    npcs: buildNpcs(pairKey, initialSigma),

    // Regime.
    regime: null,

    // Yield model state.
    yieldModel: {
      yieldEq: 0.02,
      kappa: 0.1,
      prevYield: 0.02,
      prevChange: 0,
      acov: 0,
      yieldVar: 0.0001,
    },

    // Insurance pool.
    insurancePool: initInsurancePool(),

    // Yield buffer — accumulated excess-yield contributions.
    yieldBuffer: 0,
    yieldBufferEpochs: 0,

    // Slow-epoch analytics.
    epochIndex: 0,
    correlationMap: {},

    // Regime timeline — rolling tuples of { epoch, key, label, color }.
    regimeHistory: [],

    // Lending market.
    lendingOffers: [], // { id, lenderId, amount, rate, duration }
    lendingBorrows: [], // { id, borrowerId, lenderId, amount, rate, remaining }

    // Contracts.
    imbalanceContracts: [],
    entropyContracts: [],
    strips: [],
  };
}

// Append a price to history respecting the MAX_HISTORY cap.
export function pushPrice(state, newPrice) {
  const prices = [...state.prices, newPrice].slice(-MAX_HISTORY);
  const returnHistory = prices.length > 1
    ? prices.slice(1).map((p, i) => Math.log(p / prices[i]))
    : state.returnHistory;
  return { ...state, prices, returnHistory };
}
