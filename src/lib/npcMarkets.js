// NPC market-making — post-cut this is only loss-strip demand. Lending
// market, imbalance contracts, and entropy contracts all removed.
//
// Each behavior has its own appetite for strips — "Hedger" (conservative)
// and "yield_farmer" buy strips in HIGH_VOL / CRASH regimes when risk
// transfer is most useful.

import { initStrip } from "./strips.js";

let idCounter = 0;
const uid = (prefix) => `${prefix}-${++idCounter}`;

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

// Top-level helper: produce all NPC orders for one medium epoch.
// Returns { stripBuys }. Kept as an object for call-site stability.
export function generateNpcOrders({
  npcs,
  regime,
  realizedSigma,
  returnHistory,
  // unused but retained so call sites don't break if we add products back:
  longMargin: _longMargin,
  shortMargin: _shortMargin,
  normWeights: _normWeights,
  epochIndex: _epochIndex,
}) {
  const stripBuys = [];

  for (const npc of npcs) {
    const strip = npcStripTick(npc, regime, realizedSigma, returnHistory);
    if (strip) stripBuys.push(strip);
  }

  return { stripBuys };
}
