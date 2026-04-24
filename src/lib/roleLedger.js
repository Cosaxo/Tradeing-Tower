// Role-return attribution — whitepaper §4.10.
//
// Post-cut (imbalance/entropy contracts + lending market removed), the
// per-epoch margin delta decomposes into these additive channels:
//
//   Δm_i = r_tbill·m_i          (Floor 0)
//        + y_pool·d_i           (Floor 1)
//        + PnL_auction + τ_i    (Floor 2)
//        + PnL_strip            (Floor 4 — loss strips, the only remaining
//                                user risk-transfer product)
//        + Δc_i                 (Floor 3 credit — notional)
//
// Each floor's contribution is tagged individually so the user can see
// which role produced which chunk of P&L — a decision-theoretic signal
// that aggregate P&L collapses.

const ROLES = ["tbill", "poolYield", "auctionPnl", "tips", "stripPnl", "creditChange"];

export function initLedger() {
  return {
    cumulative: Object.fromEntries(ROLES.map((k) => [k, 0])),
    lastEpoch: null,
    history: [], // rolling last N per-epoch snapshots
  };
}

export { ROLES };

// Append a single epoch's per-role contribution. Returns a new ledger.
export function appendEpochEntry(ledger, entry, historyCap = 120) {
  const prev = ledger ?? initLedger();
  const clean = Object.fromEntries(
    ROLES.map((k) => [k, Number.isFinite(entry[k]) ? entry[k] : 0])
  );
  const cumulative = Object.fromEntries(
    ROLES.map((k) => [k, (prev.cumulative?.[k] ?? 0) + clean[k]])
  );
  const epochEntry = { ...clean, epoch: entry.epoch ?? null, total: ROLES.reduce((s, k) => s + clean[k], 0) };
  return {
    cumulative,
    lastEpoch: epochEntry,
    history: [...(prev.history ?? []).slice(-(historyCap - 1)), epochEntry],
  };
}

// Convenience: total across all roles in `entry` — should equal observed Δmargin
// (modulo FP) when no external inflows/outflows occur.
export function epochTotal(entry) {
  if (!entry) return 0;
  return ROLES.reduce((s, k) => s + (entry[k] ?? 0), 0);
}

// Friendly labels for UI.
export const ROLE_LABELS = {
  tbill: "T-bill (Floor 0)",
  poolYield: "Pool Yield (Floor 1)",
  auctionPnl: "Auction P&L (Floor 2)",
  tips: "Tips (Floor 2)",
  stripPnl: "Strips (Floor 4)",
  creditChange: "Credit Δ (Floor 3)",
};

export const ROLE_COLORS = {
  tbill: "#6b7280",
  poolYield: "#a78bfa",
  auctionPnl: "#34d399",
  tips: "#fbbf24",
  stripPnl: "#60a5fa",
  creditChange: "#e879f9",
};
