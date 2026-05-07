// Tier-3 Desk — combined Layer-3 LP view (LAP pool + B-book pool).
//
// Phase 1 of the UI roadmap consolidates the two separate "LAP Pool"
// and "B-book" tabs into a single view. The protocol's Path-A default
// routes 80% of layer-3 stake to the LAP pool and 20% to the B-book
// pool; users should see them together so they understand the split,
// the combined stake, and the combined yield.
//
// This is a thin wrapper around the existing two desk components
// plus a unified header. Phase 2 of the roadmap will fold the shared
// context (your stake + yield) into a single source of truth at the
// app level.

import { LapPoolDesk } from "./LapPoolDesk.jsx";
import { BBookDesk } from "./BBookDesk.jsx";
import { HelpHint } from "./Tooltip.jsx";

export function Tier3Desk({
  // Pool states
  lapPoolState,
  bBookState,
  // Common context
  playerId = "You",
  freeMargin = 0,
  currentEpoch = 0,
  // Per-pool handlers
  onLapPoolDeposit,
  onLapPoolWithdraw,
  onBBookDeposit,
  onBBookWithdraw,
}) {
  // Combined per-user stake breakdown — both pools, both stake sources.
  const lapMy = lapPoolState?.underwriters?.[playerId];
  const lapVoluntary = lapMy?.voluntaryStake ?? 0;
  const lapThreadDerived = lapMy?.threadDerivedStake ?? 0;
  const lapTotal = lapVoluntary + lapThreadDerived;

  const bbMy = bBookState?.underwriters?.[playerId];
  const bbVoluntary = bbMy?.voluntaryStake ?? 0;
  const bbThreadDerived = bbMy?.threadDerivedStake ?? 0;
  const bbTotal = bbVoluntary + bbThreadDerived;

  const totalLayer3 = lapTotal + bbTotal;
  const lapShare = totalLayer3 > 0 ? lapTotal / totalLayer3 : 0;

  // Combined yield signals — cumulative income each pool has produced
  // across all underwriters, scaled to player's pro-rata share.
  const lapPoolStake = lapPoolState?.totalStake ?? 0;
  const bbPoolStake = bBookState?.totalStake ?? 0;
  const lapShareOfPool = lapPoolStake > 0 ? lapTotal / lapPoolStake : 0;
  const bbShareOfPool = bbPoolStake > 0 ? bbTotal / bbPoolStake : 0;

  const lapRebateIncome =
    (lapPoolState?.cumulativeRebateIncome ?? 0) * lapShareOfPool;
  const lapPoolPnl =
    (lapPoolState?.cumulativePoolPnl ?? 0) * lapShareOfPool;
  const bbPoolPnl =
    (bBookState?.cumulativePoolPnl ?? 0) * bbShareOfPool;

  const yourTotalPnl = lapRebateIncome + lapPoolPnl + bbPoolPnl;

  return (
    <div className="flex flex-col gap-3">
      {/* Combined header — your Tier-3 picture at a glance */}
      <div className="rounded-lg border border-amber-900 bg-gradient-to-br from-amber-950/40 to-gray-950 p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-xs font-mono text-amber-300 flex items-center">
            Tier 3 — Layer-3 LP
            <HelpHint
              width={420}
              text="The Tier-3 layer earns from two passive roles: the LAP pool absorbs auction imbalance and earns a stability-fee-funded rebate; the B-book pool counterparties retail flow flagged as B-classified. Both pools are passive — you stake, then earn yield (or absorb losses) pro-rata. Path-A default routes 80% of layer-3 stake to the LAP pool and 20% to the B-book pool. Adjust the split per mint via the FloatsDesk slider."
            />
          </span>
          <span className="text-[11px] font-mono text-gray-500">
            ${totalLayer3.toFixed(0)} total · ${yourTotalPnl >= 0 ? "+" : ""}
            {yourTotalPnl.toFixed(2)} P&L
          </span>
        </div>

        {/* Split visualization: how much you have in LAP vs B-book */}
        {totalLayer3 > 0 && (
          <>
            <div className="flex items-center justify-between text-[10px] font-mono mb-1">
              <span className="text-cyan-300">
                LAP pool ${lapTotal.toFixed(0)} ({(lapShare * 100).toFixed(0)}%)
              </span>
              <span className="text-pink-300">
                B-book ${bbTotal.toFixed(0)} ({((1 - lapShare) * 100).toFixed(0)}%)
              </span>
            </div>
            <div className="h-2 rounded bg-gray-900 overflow-hidden border border-gray-800 flex">
              <div
                className="bg-cyan-600 h-full"
                style={{ width: `${lapShare * 100}%` }}
              />
              <div
                className="bg-pink-600 h-full"
                style={{ width: `${(1 - lapShare) * 100}%` }}
              />
            </div>
          </>
        )}
        {totalLayer3 === 0 && (
          <div className="text-[10px] font-mono text-gray-500 mt-1">
            No Tier-3 stake yet. Mint FLOAT to auto-route 80% to LAP / 20% to B-book,
            or stake voluntarily in either pool below.
          </div>
        )}
      </div>

      {/* The two existing desks, stacked. Each remains a self-contained
          surface with deposit/withdraw flow + per-pool detail. */}
      <LapPoolDesk
        lapPoolState={lapPoolState}
        playerId={playerId}
        freeMargin={freeMargin}
        currentEpoch={currentEpoch}
        onDeposit={onLapPoolDeposit}
        onWithdraw={onLapPoolWithdraw}
      />
      <BBookDesk
        bBookState={bBookState}
        playerId={playerId}
        freeMargin={freeMargin}
        currentEpoch={currentEpoch}
        onDeposit={onBBookDeposit}
        onWithdraw={onBBookWithdraw}
      />
    </div>
  );
}
