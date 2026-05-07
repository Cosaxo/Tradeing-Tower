// WalletStrip — unified player-state surface (UI roadmap Phase 2).
//
// One always-visible strip below the header showing the player's
// dollars by role. Replaces the 5 header chips (Margin / Allocated /
// LTV / Positions / FLOAT) which scattered the same information across
// disconnected tooltips, plus parts of the right-sidebar PlayerPanel
// stats grid (Margin / P&L / LTV).
//
// Cells are color-coded by tier where applicable, matching the
// TierLadder colour language so the protocol's structure is visible
// at a glance:
//
//   gray      — free / untagged
//   violet    — threadStake (composite T1+T2+T3+T4 role)
//   cyan/pink — voluntary LAP pool / B-book stakes (Tier 3)
//   amber     — active-position margin (auction collateral)
//   emerald   — FLOAT balance (spendable T4 token)
//   fuchsia   — locked in Tier-5 spend commitments
//
// All values are derived from props; no internal state. The strip is
// re-rendered whenever the underlying state ticks, so it tracks live.

import { freeMargin } from "../lib/capitalTags.js";
import { HelpHint } from "./Tooltip.jsx";

// One labeled cell. Compact, fixed-height, color-coded.
function Cell({ label, value, color, hint, accent = false }) {
  return (
    <div
      className={`flex flex-col items-start min-w-[68px] px-2 py-1 rounded border ${color} ${
        accent ? "" : "bg-opacity-40"
      }`}
    >
      <span className="text-[9px] font-mono opacity-70 uppercase tracking-wide flex items-center">
        {label}
        {hint && <HelpHint width={280} text={hint} />}
      </span>
      <span className={`font-mono ${accent ? "text-sm font-semibold" : "text-xs"}`}>
        {value}
      </span>
    </div>
  );
}

export function WalletStrip({
  player,
  floatsState,
  commitmentState,
  poolLtv = null,
}) {
  const margin = player?.margin ?? 0;
  const tags = player?.tags ?? {};
  const playerId = player?.id ?? "You";

  // Wallet breakdown by tag.
  const free = freeMargin(margin, tags);
  const threaded = tags.threadStake ?? 0;
  const auctionPosition = tags.auctionMargin ?? 0;
  const lapVoluntary = tags.lapPoolStake ?? 0;
  const bbookVoluntary = tags.bBookStake ?? 0;

  // FLOAT balance (separate spendable token).
  const floatBalance = floatsState?.balances?.[playerId] ?? 0;

  // T5 locked: principal committed to active commitments.
  const lockedT5 = (commitmentState?.commitments ?? [])
    .filter((c) => c.userId === playerId && c.status === "ACTIVE_LOCK")
    .reduce((s, c) => s + (c.principal ?? c.amount ?? 0), 0);

  // Total wealth = wallet + FLOAT (FLOAT redeems 1:1, so it's spendable).
  const totalWealth = margin + floatBalance;

  // P&L (live, from auction settlement).
  const pnl = player?.pnl ?? 0;
  const pnlColor = pnl >= 0 ? "text-emerald-400" : "text-red-400";

  return (
    <div
      className="flex items-center gap-1.5 flex-wrap px-3 py-1.5 border-b border-gray-800 bg-gray-950/60"
      role="region"
      aria-label="Wallet summary"
    >
      {/* Total wealth — far left, accent style */}
      <Cell
        label="Total"
        value={`$${totalWealth.toFixed(0)}`}
        color="border-gray-700 bg-gray-900 text-gray-100"
        accent
        hint="Wallet margin + FLOAT balance. FLOAT redeems 1:1 to dollars (subject to redemption mechanics), so total wealth is the sum."
      />

      {/* Free margin */}
      <Cell
        label="Free"
        value={`$${free.toFixed(0)}`}
        color="border-gray-700 bg-gray-900 text-gray-300"
        hint="Untagged margin — available to stake, mint, open positions, or buy commitments."
      />

      {/* Live P&L from active position(s) */}
      {Math.abs(pnl) > 0.01 && (
        <Cell
          label="P&L"
          value={`${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`}
          color={`border-gray-700 bg-gray-900 ${pnlColor}`}
          hint="Live P&L on active auction position(s)."
        />
      )}

      <span className="text-gray-700 px-1">·</span>

      {/* Threaded — composite T1+T2+T3+T4 role */}
      {threaded > 0 && (
        <Cell
          label="Threaded"
          value={`$${threaded.toFixed(0)}`}
          color="border-violet-900 bg-violet-950/40 text-violet-200"
          hint="Margin committed as a thread — the same dollar plays four roles: T-bill principal, insurance-seller stake, layer-3 pool stake, and FLOAT mint backing."
        />
      )}

      {/* LAP pool voluntary */}
      {lapVoluntary > 0 && (
        <Cell
          label="LAP-pool"
          value={`$${lapVoluntary.toFixed(0)}`}
          color="border-cyan-800 bg-cyan-950/40 text-cyan-200"
          hint="Voluntary LAP pool LP stake. Junior tranche — earns rebate at 1.4× thread-derived rate, absorbs losses first."
        />
      )}

      {/* B-book voluntary */}
      {bbookVoluntary > 0 && (
        <Cell
          label="B-book"
          value={`$${bbookVoluntary.toFixed(0)}`}
          color="border-pink-800 bg-pink-950/40 text-pink-200"
          hint="Voluntary B-book pool stake — counterparty to retail flow flagged as B-classified."
        />
      )}

      {/* Active position margin */}
      {auctionPosition > 0 && (
        <Cell
          label="Position"
          value={`$${auctionPosition.toFixed(0)}`}
          color="border-amber-800 bg-amber-950/40 text-amber-200"
          hint="Margin tied up in open auction positions (single + paired LAPs). Frees up on close."
        />
      )}

      {/* FLOAT balance */}
      {floatBalance > 0 && (
        <Cell
          label="FLOAT"
          value={`$${floatBalance.toFixed(0)}`}
          color="border-emerald-800 bg-emerald-950/40 text-emerald-200"
          hint="Wallet FLOAT — spendable, sendable, redeemable 1:1. Backed by your thread principal."
        />
      )}

      {/* T5 locked in commitment */}
      {lockedT5 > 0 && (
        <Cell
          label="T5 locked"
          value={`$${lockedT5.toFixed(0)}`}
          color="border-fuchsia-800 bg-fuchsia-950/40 text-fuchsia-200"
          hint="FLOAT locked in an active wallet-share commitment. Released when you spend at the seller, or by partial refund on cancel/expiry."
        />
      )}

      {/* LTV — far right, subtle */}
      {poolLtv && (poolLtv.ltv ?? 0) > 0 && (
        <Cell
          label="LTV"
          value={(poolLtv.ltv ?? 0).toFixed(2)}
          color={
            (poolLtv.ltv ?? 0) >= 0.6
              ? "border-emerald-800 bg-emerald-950/40 text-emerald-200"
              : "border-gray-700 bg-gray-900 text-gray-400"
          }
          hint="Allocation diversification → mint capacity factor. ≥ 0.6 unlocks Tier-3 gate."
        />
      )}
    </div>
  );
}
