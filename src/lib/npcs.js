// NPC trader profiles. The auction spawns five counterparties with distinct
// behaviours; the `cap` ramp lets them self-adjust to volatile instruments.

import { getEffectiveCap } from "./esma.js";
import { REGIMES } from "./regime.js";

const RESTOCK_COOLDOWN = 8; // epochs an NPC sits out after liquidation

// Apply settlement results back to NPC state. Drops margin, tracks liquidation,
// and schedules restock after `RESTOCK_COOLDOWN` epochs.
export function applyNpcSettlement(npcs, settledUsers) {
  return npcs.map((npc) => {
    const settled = settledUsers.find((u) => u.id === npc.id);
    if (!settled) return npc;

    const currentMargin = npc.current_margin ?? npc.base_margin;
    const delta = (settled.margin ?? 0) - currentMargin;
    const newMargin = Math.max(0, currentMargin + delta);

    if (settled.liquidated || newMargin <= 0.01) {
      return {
        ...npc,
        current_margin: 0,
        restockRemaining: RESTOCK_COOLDOWN,
        liquidationCount: (npc.liquidationCount ?? 0) + 1,
      };
    }
    return { ...npc, current_margin: newMargin };
  });
}

// Tick down restock cooldowns; refill dead NPCs back to their base.
export function tickNpcRestock(npcs) {
  return npcs.map((npc) => {
    if ((npc.restockRemaining ?? 0) > 0) {
      const next = npc.restockRemaining - 1;
      if (next === 0) {
        return {
          ...npc,
          current_margin: npc.base_margin,
          restockRemaining: 0,
        };
      }
      return { ...npc, restockRemaining: next };
    }
    return npc;
  });
}

// Is this NPC currently active (has margin + not in cooldown)?
export function isNpcActive(npc) {
  return (npc.current_margin ?? npc.base_margin) > 0 && (npc.restockRemaining ?? 0) === 0;
}

export function buildNpcs(pairKey, realizedSigma) {
  const { effectiveCap: cap } = getEffectiveCap(pairKey, realizedSigma);
  const s = (v) => parseFloat(Math.min(cap, Math.max(0.25, v * (cap / 20))).toFixed(2));
  return [
    {
      id: "Whale",
      emoji: "",
      strategy: "FIXED_LONG",
      base_margin: 12000,
      min_lev: 0.5,
      max_lev: s(3),
      min_yield: 0.0,
      tip_tiers: [
        { lev_start: 1, lev_end: s(3), tip: 0.012, fill_direction: "bottom-up" },
      ],
      behavior: "conservative_long",
    },
    {
      id: "Degen",
      emoji: "",
      strategy: "FIXED_LONG",
      base_margin: 2000,
      min_lev: 1.0,
      max_lev: cap,
      min_yield: 0.0,
      tip_tiers: [{ lev_start: s(4), lev_end: cap, tip: 0.18, fill_direction: "top-down" }],
      behavior: "aggressive_long",
    },
    {
      id: "Hedger",
      emoji: "",
      strategy: "FIXED_SHORT",
      base_margin: 7000,
      min_lev: 0.5,
      max_lev: s(5),
      min_yield: 0.8,
      tip_tiers: [
        { lev_start: 1, lev_end: s(2), tip: 0.035, fill_direction: "bottom-up" },
      ],
      behavior: "yield_farmer",
    },
    {
      id: "Bot",
      emoji: "",
      strategy: "YIELD_CHASER",
      base_margin: 5000,
      min_lev: 0.5,
      max_lev: s(12),
      min_yield: 0.3,
      tip_tiers: [
        { lev_start: 1, lev_end: s(5), tip: 0.022, fill_direction: "bottom-up" },
      ],
      behavior: "yield_chaser",
    },
    {
      id: "Bear",
      emoji: "",
      strategy: "FIXED_SHORT",
      base_margin: 5500,
      min_lev: 0.5,
      max_lev: s(6),
      min_yield: 0.5,
      tip_tiers: [
        { lev_start: 1, lev_end: s(3), tip: 0.045, fill_direction: "bottom-up" },
      ],
      behavior: "contrarian",
    },
  ];
}

// Plain price-trend adaptation.
export function updateNpc(npc, prices) {
  if (!prices || prices.length < 2) return npc;
  const trend = (prices[prices.length - 1] - prices[0]) / prices[0];
  const u = { ...npc, tip_tiers: npc.tip_tiers.map((t) => ({ ...t })) };
  if (npc.behavior === "contrarian") {
    u.strategy = trend > 0.02 ? "FIXED_SHORT" : trend < -0.02 ? "FIXED_LONG" : npc.strategy;
  } else if (npc.behavior === "aggressive_long" && u.tip_tiers[0]) {
    u.tip_tiers[0].tip = Math.min(0.25, 0.12 + Math.abs(trend));
  } else if (npc.behavior === "yield_chaser") {
    u.strategy =
      Math.abs(trend) > 0.03
        ? trend < 0
          ? "FIXED_LONG"
          : "FIXED_SHORT"
        : "YIELD_CHASER";
  }
  return u;
}

// Regime-aware adaptation: layers regime overlays on top of the trend logic.
export function updateNpcRegime(npc, prices, regime, entropyNormWeights, yieldModel) {
  const u = updateNpc(npc, prices);
  if (!regime) return u;

  if (regime.key === "CRASH" || regime.key === "HIGH_VOL") {
    u.max_lev = Math.max(0.5, u.max_lev * 0.6);
    u.tip_tiers = u.tip_tiers.map((t) => ({
      ...t,
      lev_end: Math.min(t.lev_end, u.max_lev),
      tip: t.tip * 1.3,
    }));
    if (npc.behavior === "conservative_long" && regime.key === "CRASH") {
      u.strategy = "FIXED_SHORT";
    }
  } else if (regime.key === "CALM") {
    if (npc.behavior === "yield_chaser") {
      u.min_yield = Math.max(0, u.min_yield - 0.05);
    }
  } else if (regime.key === "TRENDING_UP") {
    if (npc.behavior === "conservative_long" || npc.behavior === "aggressive_long") {
      u.tip_tiers = u.tip_tiers.map((t) => ({ ...t, tip: t.tip * 1.1 }));
    }
  }

  if (npc.behavior === "yield_chaser" && yieldModel?.yieldEq > 0.1) {
    u.min_yield = Math.min(0.6, u.min_yield + 0.05);
  }

  // Reference entropyNormWeights is kept for future extension; not used yet
  // but documents the signal NPCs could shift toward.
  void entropyNormWeights;
  void REGIMES;
  return u;
}
