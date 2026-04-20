// NPC market-making across derivatives, strips, and the lending market.
//
// Each behavior has its own appetite for each product type — e.g. "Hedger"
// posts tight lending offers and buys strips in HIGH_VOL regimes; "Degen" buys
// imbalance contracts aggressively during trending regimes.

import { createOffer } from "./lending.js";
import { initStrip } from "./strips.js";
import { calcImbalancePremium, calcEntropyContractPremium } from "./contracts.js";

let idCounter = 0;
const uid = (prefix) => `${prefix}-${++idCounter}`;

// Stateless per-epoch decision: should `npc` post a lending offer this tick?
export function npcLendingTick(npc, existingOffers, epochIndex) {
  const already = existingOffers.some((o) => o.lenderId === npc.id && o.active);
  if (already) return null;

  const rateByBehavior = {
    conservative_long: 0.003,
    yield_farmer: 0.0025,
    yield_chaser: 0.004,
    aggressive_long: 0.008,
    contrarian: 0.006,
  };
  const rate = rateByBehavior[npc.behavior] ?? 0.005;
  const amount = Math.max(200, Math.round((npc.base_margin ?? 1000) * 0.1));
  const duration = 6 + Math.floor(((epochIndex ?? 0) % 7) + 3);

  // Only some behaviors routinely lend.
  if (!["conservative_long", "yield_farmer", "yield_chaser"].includes(npc.behavior)) {
    return null;
  }

  return createOffer(npc.id, amount, rate, duration);
}

// Should `npc` buy an imbalance contract this epoch?
export function npcImbalanceTick(npc, longMargin, shortMargin, regime) {
  if (npc.behavior !== "aggressive_long" && npc.behavior !== "contrarian") return null;

  const total = longMargin + shortMargin;
  if (total === 0) return null;
  const beta = longMargin / total;
  const imbalance = Math.abs(beta - 0.5) * 2;

  if (imbalance < 0.15) return null;

  const direction = npc.behavior === "aggressive_long"
    ? (beta > 0.5 ? "LONG" : "SHORT")
    : (beta > 0.5 ? "SHORT" : "LONG"); // contrarian fades the tilt

  const trendBoost = regime?.key === "TRENDING_UP" || regime?.key === "TRENDING_DN" ? 1.5 : 1;
  const size = Math.round((npc.base_margin ?? 1000) * 0.05 * trendBoost);
  const premium = calcImbalancePremium(longMargin, shortMargin);

  return {
    id: uid("NPC-IMB"),
    buyerId: npc.id,
    size,
    direction,
    strikeImbalance: imbalance * 0.7,
    premium,
  };
}

// Should `npc` lock an entropy contract?
export function npcEntropyTick(npc, normWeights, avgEntropyMult) {
  if (npc.behavior !== "yield_farmer" && npc.behavior !== "yield_chaser") return null;
  if (!normWeights || normWeights.length === 0) return null;
  if (avgEntropyMult < 1.15) return null;

  const size = Math.round((npc.base_margin ?? 1000) * 0.04);
  const lockedMult = Math.max(1.0, avgEntropyMult - 0.1);
  const premium = calcEntropyContractPremium(normWeights, lockedMult);

  return { id: uid("NPC-ENT"), buyerId: npc.id, size, lockedMult, premium };
}

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
// Returns { offers, imbalanceBuys, entropyBuys, stripBuys }.
export function generateNpcOrders({
  npcs,
  existingOffers,
  longMargin,
  shortMargin,
  regime,
  normWeights,
  avgEntropyMult,
  realizedSigma,
  returnHistory,
  epochIndex,
}) {
  const offers = [];
  const imbalanceBuys = [];
  const entropyBuys = [];
  const stripBuys = [];

  for (const npc of npcs) {
    const o = npcLendingTick(npc, [...existingOffers, ...offers], epochIndex);
    if (o) offers.push({ ...o, createdEpoch: epochIndex });

    const imb = npcImbalanceTick(npc, longMargin, shortMargin, regime);
    if (imb) imbalanceBuys.push(imb);

    const ent = npcEntropyTick(npc, normWeights, avgEntropyMult);
    if (ent) entropyBuys.push(ent);

    const strip = npcStripTick(npc, regime, realizedSigma, returnHistory);
    if (strip) stripBuys.push(strip);
  }

  return { offers, imbalanceBuys, entropyBuys, stripBuys };
}
