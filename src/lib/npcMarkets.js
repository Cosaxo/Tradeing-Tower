// NPC market-making — strips + rental-leg bidding.
//
// After the contract / lending / governance cuts the only remaining
// NPC products are:
//
//   - Loss strips: "Hedger" (conservative) and "yield_farmer" buy in
//     HIGH_VOL / CRASH regimes when risk transfer is most useful.
//   - Rental bids: directional NPCs (aggressive_long, contrarian) bid
//     on paired-LAP legs to get cheap directional exposure without
//     paying full LAP capital.

import { initStrip } from "./strips.js";
import { placeRentalBid, RENTAL_MARGIN_FRACTION } from "./rentalMarket.js";

let idCounter = 0;
const uid = (prefix) => `${prefix}-${++idCounter}`;

// ---------------------------------------------------------------------------
// Loss strips
// ---------------------------------------------------------------------------

// Should `npc` buy a strip this epoch?
export function npcStripTick(npc, regime, realizedSigma, returnHistory) {
  if (npc.behavior !== "conservative_long" && npc.behavior !== "yield_farmer") return null;
  if (regime?.key !== "HIGH_VOL" && regime?.key !== "CRASH") return null;

  const leverage = Math.max(1, npc.max_lev ?? 2);
  const margin = Math.round((npc.base_margin ?? 1000) * 0.15);
  const threshold = 0.2;
  const protectedFraction = 0.5;

  return initStrip({
    id: uid("NPC-STRIP"),
    leverage,
    margin,
    epochs: 8,
    realizedSigma,
    threshold,
    protectedFraction,
    returnHistory,
  });
}

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
// Returns { stripBuys, rentalBids }.
export function generateNpcOrders({
  npcs,
  regime,
  realizedSigma,
  returnHistory,
  pairKey,
  epochIndex,
  legNotionalEstimate = 1000,
  // unused but retained for call-site stability:
  longMargin: _longMargin,
  shortMargin: _shortMargin,
  normWeights: _normWeights,
}) {
  const stripBuys = [];
  const rentalBids = [];

  for (const npc of npcs) {
    const strip = npcStripTick(npc, regime, realizedSigma, returnHistory);
    if (strip) stripBuys.push(strip);

    if (pairKey) {
      const bid = npcRentalBidTick(npc, pairKey, regime, epochIndex, legNotionalEstimate);
      if (bid) rentalBids.push(bid);
    }
  }

  return { stripBuys, rentalBids };
}
