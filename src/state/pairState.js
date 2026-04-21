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
    effectiveSigma: initialSigma,
    ratioHistory: [],

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

    // Fee-flow ledger: cumulative flows of each fee category since init.
    feeLedger: {
      stabilityFee: 0,      // collected from RISKY tier settlements
      stripPremium: 0,      // collected from strip issuance
      contractPremium: 0,   // collected from imbalance + entropy contracts
      rentalIncome: 0,      // collected from lending
      routedToBuffer: 0,    // accumulated yield-buffer contributions
      routedToPool: 0,      // revenue that became pendingPremiums in the pool
      routedToDepositors: 0, // net distrib paid out to pool depositors
      claimsPaid: 0,        // drawn from pool to cover shortfalls
      bufferDraws: 0,       // drawn from buffer to cover unmet claims
      lastEpoch: null,      // { stabilityFee, stripPremium, ... } last epoch breakdown
    },

    // Slow-epoch analytics.
    epochIndex: 0,
    correlationMap: {},

    // Regime timeline — rolling tuples of { epoch, key, label, color }.
    regimeHistory: [],

    // Event ticks (for chart annotations): { epoch, type, meta }.
    events: [],

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
//
// returnHistory is maintained as its own ring buffer so it can hold a full
// MAX_HISTORY samples rather than being derived from (and thus bounded by)
// the price window. Previously the derivation collapsed to
// prices.length - 1 samples — a silent off-by-one for any consumer that
// expected its own MAX_HISTORY of returns — and rebuilt every tick in O(N).
export function pushPrice(state, newPrice) {
  const prevPrice = state.prices[state.prices.length - 1];
  const prices = [...state.prices, newPrice].slice(-MAX_HISTORY);

  let returnHistory = state.returnHistory;
  if (Number.isFinite(prevPrice) && prevPrice > 0 && Number.isFinite(newPrice) && newPrice > 0) {
    const r = Math.log(newPrice / prevPrice);
    if (Number.isFinite(r)) {
      returnHistory = [...state.returnHistory, r].slice(-MAX_HISTORY);
    }
  }

  return { ...state, prices, returnHistory };
}
