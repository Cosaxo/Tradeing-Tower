// OrderFlowAdapter — pluggable source of market flow.
//
// The adapter pattern decouples WHERE flow comes from (synthetic bots,
// replay tape, live broker) from HOW the auction/loop processes it.
// Before this seam existed, NPC state lived inside each pair's state
// and the loop read npcs[] directly. With the adapter, the loop is
// agnostic to the source.
//
// Implementations:
//
//   - DefaultBotAdapter:    behavioural NPCs (the original sim flow,
//                           preserved for parity / demo / dev).
//   - ReplayAdapter:        deterministic replay of a recorded JSON
//                           tape — reproducible backtests + tests.
//   - BrokerAdapter:        stub interface for live-market wiring
//                           (Polygon / Alpaca / Binance / IBKR / etc.).
//
// Adapter contract (each method returns plain data):
//
//   adapter.run({ pairKey, epoch, pairState, regime, yieldModel, cap })
//     → { participants, poolUsers, rentalBids, snapshot }
//
//       participants  : auction bids (full Bid shape)
//       poolUsers     : continuous-flow users for settleDominantPool
//                       (the player is NOT included — explicit-only)
//       rentalBids    : new bids to add to the rental orderbook
//       snapshot      : opaque per-pair state for UI panels
//
//   adapter.applySettlement({ pairKey, settledUsers })  → void
//
//     Caller hands back the post-settlement user list. Adapter
//     updates its internal state (NPC margin, restock scheduling,
//     etc.).
//
//   adapter.markRestockedFromSnapshot({ pairKey, prevSnapshot })  → string[]
//
//     Optional. Returns IDs of bots that just restocked this tick,
//     so the loop can log them. Default: empty.
//
// The loop calls run() once per pair per medium tick, then settles
// the dominant pool, then calls applySettlement().

// ---------------------------------------------------------------------------
// Schema guards
// ---------------------------------------------------------------------------
//
// Adapters can be backed by external data (replay tape, broker stream).
// These guards filter out malformed entries at the boundary so a bad
// upstream record can't poison the auction's internal math. Each guard
// is hand-written (no Zod dependency) and returns true if the shape
// is acceptable.

export function isValidAuctionBid(b) {
  if (!b || typeof b !== "object") return false;
  if (typeof b.id !== "string" || b.id.length === 0) return false;
  if (typeof b.strategy !== "string") return false;
  if (!Number.isFinite(b.base_margin) || b.base_margin < 0) return false;
  if (!Number.isFinite(b.max_lev) || b.max_lev <= 0) return false;
  if (b.tip_tiers != null && !Array.isArray(b.tip_tiers)) return false;
  return true;
}

export function isValidPoolUser(u) {
  if (!u || typeof u !== "object") return false;
  if (typeof u.id !== "string" || u.id.length === 0) return false;
  if (!Number.isFinite(u.margin) || u.margin < 0) return false;
  if (!Number.isFinite(u.leverage) || u.leverage <= 0) return false;
  if (u.side !== "LONG" && u.side !== "SHORT") return false;
  return true;
}

export function isValidRentalBid(b) {
  if (!b || typeof b !== "object") return false;
  if (typeof b.id !== "string" || b.id.length === 0) return false;
  if (typeof b.bidderId !== "string") return false;
  if (typeof b.pairKey !== "string") return false;
  if (!Number.isFinite(b.maxTipRate) || b.maxTipRate < 0) return false;
  if (!Number.isFinite(b.rentalMargin) || b.rentalMargin <= 0) return false;
  return true;
}

// Apply a guard to a list, dropping invalid entries silently. Returns
// { valid, dropped } so the caller can log violations.
export function filterValid(list, guard) {
  const valid = [];
  const dropped = [];
  for (const entry of list ?? []) {
    if (guard(entry)) valid.push(entry);
    else dropped.push(entry);
  }
  return { valid, dropped };
}

// ---------------------------------------------------------------------------
// Adapter shape sanity check
// ---------------------------------------------------------------------------

// Light runtime check — ensures the adapter exposes the methods the
// loop expects. Throws on misconfiguration so it's caught at startup,
// not deep inside the tick callback.
export function assertAdapter(adapter, name = "adapter") {
  const required = ["run", "applySettlement"];
  for (const m of required) {
    if (typeof adapter?.[m] !== "function") {
      throw new Error(`OrderFlowAdapter ${name} missing required method '${m}'`);
    }
  }
  return adapter;
}
