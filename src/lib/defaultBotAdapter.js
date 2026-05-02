// DefaultBotAdapter — wraps the legacy NPC behaviour as an
// OrderFlowAdapter. Preserves the existing simulator flow (Whale,
// Degen, Hedger, Bot, Bear) while moving NPC state out of the
// per-pair pairState.npcs array and behind the adapter seam.
//
// The loop now depends only on the adapter interface. Swapping in
// ReplayAdapter or BrokerAdapter doesn't require any auction-loop
// changes.

import { buildNpcs, updateNpcRegime, applyNpcSettlement, tickNpcRestock, isNpcActive } from "./npcs.js";
import { generateNpcOrders } from "./npcMarkets.js";

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDefaultBotAdapter({ pairKeys = [], realizedSigmaByPair = {} } = {}) {
  // Internal per-pair NPC state. The loop never sees this directly —
  // it's exposed only via run() output.
  const byPair = {};
  for (const pk of pairKeys) {
    byPair[pk] = {
      npcs: buildNpcs(pk, realizedSigmaByPair[pk] ?? 0.02),
      preTickSnapshot: null, // for restock detection
    };
  }

  function ensurePair(pairKey, realizedSigma) {
    if (!byPair[pairKey]) {
      byPair[pairKey] = {
        npcs: buildNpcs(pairKey, realizedSigma ?? 0.02),
        preTickSnapshot: null,
      };
    }
    return byPair[pairKey];
  }

  return {
    // Single-call run: regime-update, restock, build participants /
    // poolUsers / rentalBids, return snapshot for UI.
    run({ pairKey, epoch, pairState, regime, yieldModel, cap }) {
      const slot = ensurePair(pairKey, pairState?.realizedSigma);
      const prices = pairState?.prices ?? [];

      const regimeUpdated = slot.npcs.map((npc) =>
        updateNpcRegime(npc, prices.slice(-20), regime, null, yieldModel)
      );
      // Snapshot BEFORE restock so the loop can detect "just restocked"
      // by id-matching.
      slot.preTickSnapshot = regimeUpdated;
      const restocked = tickNpcRestock(regimeUpdated);
      slot.npcs = restocked;

      const active = restocked.filter(isNpcActive);

      // Auction participants — capped leverage, current margin.
      const participants = active.map((n) => ({
        ...n,
        base_margin: n.current_margin ?? n.base_margin,
        max_lev: Math.min(n.max_lev, cap ?? n.max_lev),
      }));

      // Pool settlement users — minimal shape.
      const poolUsers = active.map((n) => ({
        id: n.id,
        margin: n.current_margin ?? n.base_margin,
        leverage: Math.min(n.max_lev, cap ?? n.max_lev),
        side: n.strategy?.includes("SHORT") ? "SHORT" : "LONG",
        active: true,
      }));

      // Rental bids on paired-LAP legs.
      const npcOrders = generateNpcOrders({
        npcs: active,
        regime,
        pairKey,
        epochIndex: epoch,
        legNotionalEstimate: 1000,
      });

      return {
        participants,
        poolUsers,
        rentalBids: npcOrders.rentalBids ?? [],
        snapshot: restocked,
      };
    },

    // Apply settlement results back to NPC state.
    applySettlement({ pairKey, settledUsers }) {
      const slot = byPair[pairKey];
      if (!slot) return;
      slot.npcs = applyNpcSettlement(slot.npcs, settledUsers ?? []);
    },

    // Detect bots that JUST restocked this tick. Compares pre-tick
    // snapshot against the post-tick state by id; emits IDs that went
    // from restockRemaining=1 to 0.
    markRestockedFromSnapshot({ pairKey }) {
      const slot = byPair[pairKey];
      if (!slot || !slot.preTickSnapshot) return [];
      const preById = new Map(slot.preTickSnapshot.map((n) => [n.id, n]));
      const restocked = [];
      for (const n of slot.npcs) {
        const pre = preById.get(n.id);
        if ((pre?.restockRemaining ?? 0) === 1 && (n.restockRemaining ?? 0) === 0) {
          restocked.push(n.id);
        }
      }
      return restocked;
    },

    // Liquidations this tick — by id-comparison against the pre-settlement
    // snapshot. The loop logs these.
    detectLiquidationsFromSnapshot({ pairKey, preSettlementSnapshot }) {
      const slot = byPair[pairKey];
      if (!slot) return [];
      const preById = new Map((preSettlementSnapshot ?? []).map((n) => [n.id, n]));
      const dead = [];
      for (const n of slot.npcs) {
        const pre = preById.get(n.id);
        const preMargin = pre?.current_margin ?? pre?.base_margin ?? 0;
        if (preMargin > 0 && n.current_margin === 0) {
          dead.push({ id: n.id, restockRemaining: n.restockRemaining });
        }
      }
      return dead;
    },

    // Read-only snapshot for UI (e.g. NpcPanel).
    getSnapshot(pairKey) {
      return byPair[pairKey]?.npcs ?? [];
    },
  };
}
