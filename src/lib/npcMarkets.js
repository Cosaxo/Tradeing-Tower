// NPC market-making — rental-leg bidding only.
//
// After the Phase-5 cut of strips and the per-pair insurance pool,
// directional NPCs (aggressive_long, contrarian, yield_chaser) bid on
// paired-LAP legs to get cheap directional exposure without paying
// full LAP capital. Other behaviors don't actively trade in v1.

import { placeRentalBid, RENTAL_MARGIN_FRACTION } from "./rentalMarket.js";

let idCounter = 0;
const _uid = (prefix) => `${prefix}-${++idCounter}`;
void _uid; // reserved for future product types

// ---------------------------------------------------------------------------
// Rental bidding
// ---------------------------------------------------------------------------

// Per-behavior willingness to pay for leg exposure. Higher = more
// aggressive demand. Multiplied against the legNotional to size the
// bid's `maxTipRate`.
const RENTAL_TIP_BIAS = {
  aggressive_long: 0.012,  // happy to pay above floor for cheap leverage
  contrarian:      0.010,
  yield_chaser:    0.008,
  yield_farmer:    0.000,  // doesn't rent — buys strips instead
  conservative_long: 0.000, // doesn't rent
};

// Should `npc` bid for a rental leg on `pairKey` this epoch?
//
// Returns null if the NPC isn't a renter behavior, or if the regime
// suggests directional bets aren't favored, or if the NPC's margin
// can't support the rental margin.
export function npcRentalBidTick(npc, pairKey, regime, currentEpoch, legNotionalEstimate) {
  const tipBias = RENTAL_TIP_BIAS[npc.behavior] ?? 0;
  if (tipBias <= 0) return null;

  // Aggressive bidders skew higher in trending regimes.
  const trendMult =
    regime?.key === "TRENDING_UP" || regime?.key === "TRENDING_DN" ? 1.4 : 1.0;
  const maxTipRate = tipBias * trendMult;

  // Rental margin sized at RENTAL_MARGIN_FRACTION of leg notional.
  // legNotionalEstimate is supplied by the caller (uses a typical
  // paired-LAP size since the bid is published before a specific match).
  const rentalMargin = Math.round((legNotionalEstimate ?? 1000) * RENTAL_MARGIN_FRACTION);
  if (rentalMargin <= 0) return null;
  if ((npc.current_margin ?? npc.base_margin ?? 0) < rentalMargin) return null;

  return placeRentalBid({
    bidderId: npc.id,
    pairKey,
    maxTipRate,
    durationEpochs: 5,
    rentalMargin,
    publishedAtEpoch: currentEpoch ?? 0,
  });
}

// ---------------------------------------------------------------------------
// Top-level orchestrator
// ---------------------------------------------------------------------------

// Produce all NPC orders for one medium epoch on a pair.
// Returns { rentalBids } (strips were removed in Phase 5).
export function generateNpcOrders({
  npcs,
  regime,
  pairKey,
  epochIndex,
  legNotionalEstimate = 1000,
  // unused but retained for call-site stability:
  realizedSigma: _realizedSigma,
  returnHistory: _returnHistory,
  longMargin: _longMargin,
  shortMargin: _shortMargin,
  normWeights: _normWeights,
}) {
  const rentalBids = [];

  for (const npc of npcs) {
    if (pairKey) {
      const bid = npcRentalBidTick(npc, pairKey, regime, epochIndex, legNotionalEstimate);
      if (bid) rentalBids.push(bid);
    }
  }

  return { rentalBids };
}
