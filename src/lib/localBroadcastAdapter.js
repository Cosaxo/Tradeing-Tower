// LocalBroadcastAdapter — multi-user OrderFlowAdapter that wires
// real human users together via the browser's BroadcastChannel.
//
// What it does
// ------------
// Each browser tab is a "user" in a shared "room". Tabs broadcast
// their current bid (player config: leverage / margin / side /
// strategy / tip tiers / activePair) on a periodic heartbeat. Other
// tabs in the same room collect those broadcasts and surface them as
// auction participants when the medium tick runs.
//
// This replaces the legacy DefaultBotAdapter (synthetic NPC flow).
// The protocol becomes a real multi-user trading platform — no fake
// counterparties — at the cost of needing at least one other open
// tab to see auction matches.
//
// What it doesn't do (yet)
// ------------------------
// Cross-tab protocol-state sync. Each tab settles its own insurance
// markets, B-book pool, FLOAT state. Two tabs running in parallel will
// drift slightly because settlement is per-tab. A real backend
// removes this divergence; for now it's a known demo limitation.
// Tradable cross-tab effects: auction tips, classifier flow.
//
// Failure modes
// -------------
// - BroadcastChannel unavailable (old browsers, some embed contexts):
//   factory returns a null adapter. UI degrades gracefully — solo
//   user with no flow.
// - Tab unresponsive: peers prune entries that haven't broadcast in
//   PEER_TIMEOUT_MS (default 10s). No spurious matches against dead
//   tabs.

const PRESENCE_INTERVAL_MS = 3000;
const PEER_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Null adapter — used when BroadcastChannel isn't available.
// ---------------------------------------------------------------------------

function createNullAdapter() {
  return {
    run() {
      return { participants: [], poolUsers: [], rentalBids: [], snapshot: [] };
    },
    applySettlement() {},
    markRestockedFromSnapshot() {
      return [];
    },
    detectLiquidationsFromSnapshot() {
      return [];
    },
    getSnapshot() {
      return [];
    },
    getPeerCount() {
      return 0;
    },
    getRoomId() {
      return null;
    },
    isAvailable() {
      return false;
    },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

// `tabUserId` — unique per browser tab. Two tabs on the same machine
//   must have different IDs or the auction can't differentiate them.
// `roomId` — shared "room" identifier. Tabs in the same room exchange
//   flow; tabs in different rooms are isolated.
// `getCurrentBid` — function that returns the current local player bid
//   on each heartbeat. Shape:
//
//     {
//       pairKey, leverage, margin, side,
//       strategy, tip_tiers
//     }
//
//   May return null when there's no active local bid (e.g. solo user
//   with no allocation). When null, this tab broadcasts presence but
//   no matchable bid — peers see it but won't auction against it.
export function createLocalBroadcastAdapter({
  tabUserId,
  roomId = "default",
  getCurrentBid = () => null,
} = {}) {
  if (
    typeof window === "undefined" ||
    typeof BroadcastChannel === "undefined" ||
    !tabUserId
  ) {
    return createNullAdapter();
  }

  let channel;
  try {
    channel = new BroadcastChannel(`tt-room-${roomId}`);
  } catch (e) {
    // Some embed contexts (eg. older WebViews) reject construction.
    // Fall back rather than crash.
    return createNullAdapter();
  }

  // peers: Map<tabUserId, { lastSeen, bid }>
  const peers = new Map();

  function pruneStalePeers() {
    const now = Date.now();
    for (const [k, v] of peers.entries()) {
      if (now - v.lastSeen > PEER_TIMEOUT_MS) peers.delete(k);
    }
  }

  channel.onmessage = (ev) => {
    const m = ev?.data;
    if (!m || typeof m !== "object" || m.userId === tabUserId) return;
    if (m.type === "presence") {
      peers.set(m.userId, {
        lastSeen: Date.now(),
        bid: m.bid ?? null,
      });
    } else if (m.type === "leaving") {
      peers.delete(m.userId);
    }
  };

  // Periodic heartbeat — broadcast presence + current bid. The poll
  // interval is short relative to the medium tick so peer flow lags
  // by at most one heartbeat at the auction boundary.
  const heartbeatId = setInterval(() => {
    pruneStalePeers();
    let bid = null;
    try {
      bid = getCurrentBid() ?? null;
    } catch {
      bid = null;
    }
    try {
      channel.postMessage({
        type: "presence",
        userId: tabUserId,
        bid,
        ts: Date.now(),
      });
    } catch {
      // postMessage can throw if the channel is mid-close. Ignore.
    }
  }, PRESENCE_INTERVAL_MS);

  // Best-effort leave broadcast on tab close. The peer's prune timer
  // catches stragglers.
  const onUnload = () => {
    try {
      channel.postMessage({ type: "leaving", userId: tabUserId });
      channel.close();
    } catch {}
  };
  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", onUnload);
  }

  // -------------------------------------------------------------------------
  // Adapter contract
  // -------------------------------------------------------------------------
  return {
    run({ pairKey, cap }) {
      pruneStalePeers();
      const activeBids = [];
      for (const [uid, p] of peers.entries()) {
        if (!p.bid || p.bid.pairKey !== pairKey) continue;
        const margin = Math.max(1, p.bid.margin ?? 1000);
        const leverage = Math.max(0.5, p.bid.leverage ?? 1);
        const side = p.bid.side === "SHORT" ? "SHORT" : "LONG";
        activeBids.push({
          id: uid,
          base_margin: margin,
          max_lev: Math.min(leverage, cap ?? leverage),
          strategy: p.bid.strategy ?? (side === "SHORT" ? "FIXED_SHORT" : "FIXED_LONG"),
          tip_tiers: p.bid.tip_tiers ?? [
            { lev_start: 1.0, lev_end: 2.0, tip: 0.02, fill_direction: "bottom-up" },
          ],
          activePair: pairKey,
          // Echo the raw bid fields for downstream consumers that
          // expect plain margin/leverage/side keys.
          margin,
          leverage,
          side,
        });
      }

      // Continuous-ambient pool flow mirrors auction participants. With
      // no synthetic NPCs, the only continuous flow is from peer bids.
      const poolUsers = activeBids.map((b) => ({
        id: b.id,
        margin: b.base_margin,
        leverage: b.max_lev,
        side: b.side,
        active: true,
      }));

      return {
        participants: activeBids,
        poolUsers,
        rentalBids: [],
        snapshot: activeBids,
      };
    },

    // Settlement results aren't fed back to peers — each tab settles
    // its own protocol state. Cross-tab consistency is best-effort.
    applySettlement() {},

    // No restock concept for real users.
    markRestockedFromSnapshot() {
      return [];
    },

    // No liquidation detection — peers manage their own positions.
    detectLiquidationsFromSnapshot() {
      return [];
    },

    getSnapshot() {
      return Array.from(peers.entries()).map(([uid, p]) => ({
        id: uid,
        lastSeen: p.lastSeen,
        ...(p.bid ?? {}),
      }));
    },

    // ---------------------------------------------------------------------
    // Multi-user-specific extensions (UI uses these via flowAdapter)
    // ---------------------------------------------------------------------

    getPeerCount() {
      pruneStalePeers();
      return peers.size;
    },

    getRoomId() {
      return roomId;
    },

    isAvailable() {
      return true;
    },

    dispose() {
      clearInterval(heartbeatId);
      if (typeof window !== "undefined") {
        window.removeEventListener("beforeunload", onUnload);
      }
      onUnload();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-tab user ID generator
// ---------------------------------------------------------------------------

// Generates / retrieves a unique user ID for THIS browser tab. Stored
// in sessionStorage (per-tab) so each tab gets a different ID even
// when localStorage shares state between them. Falls back to a fresh
// random ID per call when sessionStorage is unavailable.
//
// `displayName` is used as a prefix so peer lists are readable
// ("You-7k3a", "You-9q1m") rather than opaque hashes.
const TAB_USER_ID_KEY = "tt.tabUserId";

export function getOrCreateTabUserId(displayName = "You") {
  const suffix = randomShortId();
  const id = `${displayName}-${suffix}`;

  if (typeof window === "undefined") return id;
  try {
    const existing = window.sessionStorage.getItem(TAB_USER_ID_KEY);
    if (existing) return existing;
    window.sessionStorage.setItem(TAB_USER_ID_KEY, id);
    return id;
  } catch {
    return id;
  }
}

function randomShortId() {
  // 4 base36 chars ≈ 1.6M values — collision-vanishingly-rare for the
  // typical 2–10 tab demo room, no crypto requirement.
  return Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
}
