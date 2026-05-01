// B-book Desk — underwriter UI.
//
// The protocol's open replacement for the hidden B-book that retail
// CFD brokers run against unprofitable customers. Anyone can opt in
// here as a B-book underwriter:
//
//   - Deposit collateral (tagged `bBookStake`).
//   - Earn the B-classified users' tip stream.
//   - Absorb the directional P&L of those users' contracts pro-rata
//     to your share of the pool.
//   - Withdraw after the lockup expires (BBOOK_LOCKUP_EPOCHS).
//
// Risk: skilled traders flagged as "whales" force-class to A so the
// pool isn't drained by single-shot blow-ups; the pool also caps total
// active notional at BBOOK_MAX_NOTIONAL_RATIO × stake. If those
// safeguards fail, your position can lose up to your full stake.
//
// All state is derived from `bBookState` — pure read-only display
// here; the App handlers do the actual deposits/withdrawals.

import { useState } from "react";
import { HelpHint } from "./Tooltip.jsx";
import {
  BBOOK_MAX_NOTIONAL_RATIO,
  BBOOK_LOCKUP_EPOCHS,
} from "../constants/system.js";

export function BBookDesk({
  bBookState,
  playerId = "You",
  freeMargin = 0,
  currentEpoch = 0,
  onDeposit,
  onWithdraw,
}) {
  const [depositAmount, setDepositAmount] = useState(500);
  const [withdrawAmount, setWithdrawAmount] = useState(100);

  const my = bBookState?.underwriters?.[playerId];
  const myStake = my?.stake ?? 0;
  const myLockedUntil = my?.lockupReleaseEpoch ?? 0;
  const lockedFor = Math.max(0, myLockedUntil - currentEpoch);

  const totalStake = bBookState?.totalStake ?? 0;
  const activeContracts = bBookState?.activeContracts ?? [];
  const activeNotional = activeContracts.reduce(
    (s, c) => s + (c.margin ?? 0) * (c.leverage ?? 1),
    0
  );
  const utilization = totalStake > 0 ? activeNotional / totalStake : 0;
  const utilizationPct = Math.min(100, utilization / BBOOK_MAX_NOTIONAL_RATIO * 100);
  const sharePct = totalStake > 0 ? (myStake / totalStake) * 100 : 0;
  const cumulativePoolPnl = bBookState?.cumulativePoolPnl ?? 0;

  const depositMax = Math.max(0, Math.floor(freeMargin));
  const canWithdraw = lockedFor === 0;

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          B-book Underwriter
          <HelpHint
            width={360}
            text="Opt-in counterparty pool for B-classified user flow. Anyone can stake here to earn the user tip stream + absorb their directional P&L pro-rata. Replaces the hidden broker B-book of traditional CFDs with a transparent, open marketplace. Lockup applies; capacity capped at MAX_NOTIONAL_RATIO × stake to protect underwriters."
          />
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-pink-700 bg-pink-950 text-pink-200">
          your stake ${myStake.toFixed(0)}
        </span>
      </div>

      {/* Pool stats */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Pool stake</div>
          <div className="text-sm font-mono text-pink-200">${totalStake.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Active notional</div>
          <div className="text-sm font-mono text-amber-300">${activeNotional.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Contracts</div>
          <div className="text-sm font-mono text-indigo-300">{activeContracts.length}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Pool P&L</div>
          <div className={`text-sm font-mono ${cumulativePoolPnl >= 0 ? "text-emerald-300" : "text-red-300"}`}>
            {cumulativePoolPnl >= 0 ? "+" : ""}${cumulativePoolPnl.toFixed(0)}
          </div>
        </div>
      </div>

      {/* Utilisation bar */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[9px] font-mono text-gray-500">
          <span>Utilisation (notional / stake)</span>
          <span>
            {(utilization * 100).toFixed(0)}% of {(BBOOK_MAX_NOTIONAL_RATIO * 100).toFixed(0)}% cap
          </span>
        </div>
        <div className="h-2 rounded bg-gray-800 overflow-hidden border border-gray-700">
          <div
            className={`h-full ${
              utilizationPct > 80
                ? "bg-red-600"
                : utilizationPct > 50
                ? "bg-amber-500"
                : "bg-pink-500"
            }`}
            style={{ width: `${utilizationPct}%` }}
          />
        </div>
      </div>

      {/* Your share */}
      {myStake > 0 && (
        <div className="text-[10px] font-mono text-gray-400 border border-gray-800 bg-gray-950 px-2 py-1 rounded">
          Your share: <span className="text-pink-300">{sharePct.toFixed(1)}%</span> of pool ·{" "}
          {lockedFor > 0
            ? `locked for ${lockedFor} more epochs`
            : "unlocked — withdraw any time"}
        </div>
      )}

      {/* Deposit */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Deposit underwriter capital
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={50}
            max={Math.max(50, depositMax)}
            step={50}
            value={Math.min(depositAmount, Math.max(50, depositMax))}
            onChange={(e) => setDepositAmount(parseInt(e.target.value))}
            className="flex-1 accent-pink-500"
            disabled={depositMax < 50}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${depositAmount}
          </span>
          <button
            onClick={() => onDeposit?.(depositAmount)}
            disabled={depositMax < 50 || depositAmount > depositMax}
            className="text-[10px] font-mono px-3 py-1 rounded border border-pink-700 bg-pink-950 text-pink-200 hover:bg-pink-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Stake
          </button>
        </div>
        <div className="text-[9px] font-mono text-gray-600">
          Tagged as <span className="text-pink-300">bBookStake</span> ·
          locked for {BBOOK_LOCKUP_EPOCHS} epochs · earns user tip flow + their P&L
        </div>
      </div>

      {/* Withdraw */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Withdraw stake
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={Math.max(1, Math.floor(myStake))}
            step={1}
            value={Math.min(withdrawAmount, Math.max(1, Math.floor(myStake)))}
            onChange={(e) => setWithdrawAmount(parseInt(e.target.value))}
            className="flex-1 accent-pink-500"
            disabled={myStake < 1 || !canWithdraw}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${withdrawAmount}
          </span>
          <button
            onClick={() => onWithdraw?.(withdrawAmount)}
            disabled={myStake < 1 || !canWithdraw || withdrawAmount > myStake}
            className="text-[10px] font-mono px-3 py-1 rounded border border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Withdraw
          </button>
        </div>
        {!canWithdraw && myStake > 0 && (
          <div className="text-[9px] font-mono text-amber-400">
            Locked for {lockedFor} more epochs (re-deposits push the lock further out).
          </div>
        )}
      </div>

      {/* Active contracts list */}
      {activeContracts.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
          <div className="text-[10px] text-gray-500 font-mono uppercase mb-1">
            Active contracts ({activeContracts.length})
          </div>
          <div className="flex flex-col gap-0.5">
            {activeContracts.slice(0, 8).map((c) => (
              <div
                key={c.id}
                className="flex items-center justify-between text-[10px] font-mono text-gray-300"
              >
                <span className="truncate">
                  {c.userId} {c.side} {c.pairKey}
                </span>
                <span className="text-gray-400">
                  ${c.margin.toFixed(0)} × {c.leverage.toFixed(1)}×
                </span>
              </div>
            ))}
            {activeContracts.length > 8 && (
              <div className="text-[9px] font-mono text-gray-600">
                + {activeContracts.length - 8} more...
              </div>
            )}
          </div>
        </div>
      )}

      {totalStake === 0 && (
        <div className="text-[10px] font-mono text-gray-500 border border-gray-800 px-2 py-1 rounded">
          No underwriters yet. Stake to start earning B-classified user tip flow.
        </div>
      )}
    </div>
  );
}
