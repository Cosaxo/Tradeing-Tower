// LAP-pool Desk — passive-LP UI.
//
// The LAP pool is the Tier-3 default role. Stake here to absorb auction
// imbalance and earn the rebate stream funded by the per-tick stability
// fee. Mirrors BBookDesk in shape but the economics are:
//
//   - Pool absorbs UNMATCHED bids (the surplus side of auction flow).
//   - Each absorbed contract earns the entropy-weighted tip rate.
//   - Rebate is funded from the protocol's stability-fee revenue
//     (cap LAP_POOL_REBATE_FEE_SHARE = 70% of fee per tick).
//   - Absorbed contracts close after LAP_POOL_HOLD_EPOCHS or earlier
//     when the pool's directional position needs to unwind.
//   - Underwriters share P&L pro-rata.
//
// Risk: directional P&L from absorbed contracts (zero-mean in
// expectation but realised P&L can swing on volatile ticks).

import { useState } from "react";
import { HelpHint } from "./Tooltip.jsx";
import {
  BBOOK_MAX_NOTIONAL_RATIO,
  LAP_POOL_LOCKUP_EPOCHS,
  LAP_POOL_HOLD_EPOCHS,
} from "../constants/system.js";

export function LapPoolDesk({
  lapPoolState,
  playerId = "You",
  freeMargin = 0,
  currentEpoch = 0,
  onDeposit,
  onWithdraw,
}) {
  const [depositAmount, setDepositAmount] = useState(500);
  const [withdrawAmount, setWithdrawAmount] = useState(100);

  const my = lapPoolState?.underwriters?.[playerId];
  const myVoluntary = my?.voluntaryStake ?? 0;
  const myThreadDerived = my?.threadDerivedStake ?? 0;
  const myStake = myVoluntary + myThreadDerived;
  const myLockedUntil = my?.lockupReleaseEpoch ?? 0;
  const lockedFor = Math.max(0, myLockedUntil - currentEpoch);

  const totalStake = lapPoolState?.totalStake ?? 0;
  const activeAbsorbed = lapPoolState?.activeAbsorbed ?? [];
  const activeNotional = activeAbsorbed.reduce(
    (s, c) => s + (c.margin ?? 0) * (c.leverage ?? 1),
    0
  );
  const utilization = totalStake > 0 ? activeNotional / totalStake : 0;
  const utilizationPct = Math.min(100, (utilization / BBOOK_MAX_NOTIONAL_RATIO) * 100);
  const sharePct = totalStake > 0 ? (myStake / totalStake) * 100 : 0;
  const cumulativeRebate = lapPoolState?.cumulativeRebateIncome ?? 0;
  const cumulativePoolPnl = lapPoolState?.cumulativePoolPnl ?? 0;
  const cumulativeTotal = cumulativeRebate + cumulativePoolPnl;

  const depositMax = Math.max(0, Math.floor(freeMargin));
  const canWithdraw = lockedFor === 0;

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          LAP Pool — passive LP
          <HelpHint
            width={400}
            text="Tier-3 default role. The pool absorbs the surplus side of imbalanced auction flow and earns the structural tip rate the imbalance pays. Rebate income is funded from the protocol's stability-fee revenue — every dollar of pool growth comes from a real fee debit, not synthesis. Absorbed contracts unwind after LAP_POOL_HOLD_EPOCHS so directional risk is bounded."
          />
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-cyan-700 bg-cyan-950 text-cyan-200">
          your stake ${myStake.toFixed(0)}
        </span>
      </div>

      {/* Pool stats */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Pool stake</div>
          <div className="text-sm font-mono text-cyan-200">${totalStake.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Absorbed</div>
          <div className="text-sm font-mono text-indigo-300">{activeAbsorbed.length}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Rebate income</div>
          <div className="text-sm font-mono text-emerald-300">+${cumulativeRebate.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Net</div>
          <div className={`text-sm font-mono ${cumulativeTotal >= 0 ? "text-emerald-300" : "text-red-300"}`}>
            {cumulativeTotal >= 0 ? "+" : ""}${cumulativeTotal.toFixed(0)}
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
                : "bg-cyan-500"
            }`}
            style={{ width: `${utilizationPct}%` }}
          />
        </div>
      </div>

      {/* Your share — split by source */}
      {myStake > 0 && (
        <div className="flex flex-col gap-1 text-[10px] font-mono border border-gray-800 bg-gray-950 px-2 py-1 rounded">
          <div className="text-gray-400">
            Your share: <span className="text-cyan-300">{sharePct.toFixed(1)}%</span> of pool
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <span className="text-gray-500">voluntary </span>
              <span className="text-cyan-300">${myVoluntary.toFixed(0)}</span>
              <span className="text-gray-600 ml-1">
                {lockedFor > 0 ? `· locked ${lockedFor}ep` : "· unlocked"}
              </span>
            </div>
            <div>
              <span className="text-gray-500">from threads </span>
              <span className="text-amber-300">${myThreadDerived.toFixed(0)}</span>
              <span className="text-gray-600 ml-1">· thread-locked</span>
            </div>
          </div>
        </div>
      )}

      {/* Deposit */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Stake voluntary capital
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={50}
            max={Math.max(50, depositMax)}
            step={50}
            value={Math.min(depositAmount, Math.max(50, depositMax))}
            onChange={(e) => setDepositAmount(parseInt(e.target.value))}
            className="flex-1 accent-cyan-500"
            disabled={depositMax < 50}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${depositAmount}
          </span>
          <button
            onClick={() => onDeposit?.(depositAmount)}
            disabled={depositMax < 50 || depositAmount > depositMax}
            className="text-[10px] font-mono px-3 py-1 rounded border border-cyan-700 bg-cyan-950 text-cyan-200 hover:bg-cyan-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Stake
          </button>
        </div>
        <div className="text-[9px] font-mono text-gray-600">
          Tagged as <span className="text-cyan-300">lapPoolStake</span> · locked for{" "}
          {LAP_POOL_LOCKUP_EPOCHS} epochs · contracts age out after {LAP_POOL_HOLD_EPOCHS}{" "}
          ticks
        </div>
      </div>

      {/* Withdraw */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Withdraw voluntary stake
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={Math.max(1, Math.floor(myVoluntary))}
            step={1}
            value={Math.min(withdrawAmount, Math.max(1, Math.floor(myVoluntary)))}
            onChange={(e) => setWithdrawAmount(parseInt(e.target.value))}
            className="flex-1 accent-cyan-500"
            disabled={myVoluntary < 1 || !canWithdraw}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${withdrawAmount}
          </span>
          <button
            onClick={() => onWithdraw?.(withdrawAmount)}
            disabled={myVoluntary < 1 || !canWithdraw || withdrawAmount > myVoluntary}
            className="text-[10px] font-mono px-3 py-1 rounded border border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Withdraw
          </button>
        </div>
        {!canWithdraw && myVoluntary > 0 && (
          <div className="text-[9px] font-mono text-amber-400">
            Locked for {lockedFor} more epochs (re-deposits push the lock further out).
          </div>
        )}
        {myThreadDerived > 0 && (
          <div className="text-[9px] font-mono text-gray-600">
            Thread-derived stake (${myThreadDerived.toFixed(0)}) redeems via the FLOAT
            redemption cycle, not from this desk.
          </div>
        )}
      </div>

      {/* Active absorbed contracts list */}
      {activeAbsorbed.length > 0 && (
        <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
          <div className="text-[10px] text-gray-500 font-mono uppercase mb-1">
            Absorbed positions ({activeAbsorbed.length})
          </div>
          <div className="flex flex-col gap-0.5">
            {activeAbsorbed.slice(0, 8).map((c) => {
              const age = currentEpoch - (c.openedAtEpoch ?? currentEpoch);
              return (
                <div
                  key={c.id}
                  className="flex items-center justify-between text-[10px] font-mono text-gray-300"
                >
                  <span className="truncate">
                    {c.side} {c.pairKey} ·{" "}
                    <span className="text-gray-500">age {age}ep</span>
                  </span>
                  <span className="text-gray-400">
                    ${c.margin.toFixed(0)} × {c.leverage.toFixed(1)}×
                  </span>
                </div>
              );
            })}
            {activeAbsorbed.length > 8 && (
              <div className="text-[9px] font-mono text-gray-600">
                + {activeAbsorbed.length - 8} more...
              </div>
            )}
          </div>
        </div>
      )}

      {totalStake === 0 && (
        <div className="text-[10px] font-mono text-gray-500 border border-gray-800 px-2 py-1 rounded">
          No LPs yet. Stake to start earning the auction-imbalance rebate stream.
        </div>
      )}
    </div>
  );
}
