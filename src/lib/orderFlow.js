// OrderFlowAdapter — the seam where real participant flow enters the auction.
//
// The legacy demo populated the auction with five hard-coded synthetic
// counterparties ("NPCs"). That path is removed. A real deployment plugs
// flow in through one of:
//
//   - A live participant feed (authenticated traders posting bids).
//   - A broker / exchange connector (translates an external book into the
//     LAP bid shape).
//   - A historical-tape replay (CSV/JSON of recorded participant bids).
//
// All such sources implement the OrderFlowAdapter contract:
//
//   getBids(ctx)
//     ctx = { pairKey, currentEpoch, regime, realizedSigma, cap }
//     returns Array<{
//       id, strategy: "FIXED_LONG" | "FIXED_SHORT" | "YIELD_CHASER",
//       base_margin, max_lev, tip_tiers, min_yield?, behavior?
//     }>
//
//   getPoolUsers(ctx)            (optional)
//     If the adapter wants its participants to enter pool settlement as
//     well (i.e. they hold positions, not just submit bids), return the
//     position rows here. Same userId space as `getBids`.
//
// The default export is a NULL adapter — it returns nothing. The auction
// already short-circuits on an empty book, so the system stays functional
// with no flow attached.

export const NULL_ORDER_FLOW_ADAPTER = {
  id: "null",
  getBids: () => [],
  getPoolUsers: () => [],
};

export function getBids(adapter, ctx) {
  if (!adapter || typeof adapter.getBids !== "function") return [];
  try {
    const bids = adapter.getBids(ctx);
    return Array.isArray(bids) ? bids : [];
  } catch {
    return [];
  }
}

export function getPoolUsers(adapter, ctx) {
  if (!adapter || typeof adapter.getPoolUsers !== "function") return [];
  try {
    const users = adapter.getPoolUsers(ctx);
    return Array.isArray(users) ? users : [];
  } catch {
    return [];
  }
}
