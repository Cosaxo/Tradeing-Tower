// Insurance pool deposit/withdraw desk.
import { useState } from "react";
import { HelpHint } from "./Tooltip.jsx";

export function PoolDesk({ pool, playerId = "You", playerMargin, onDeposit, onWithdraw }) {
  const [amount, setAmount] = useState(500);

  const myDeposit = pool?.deposits?.[playerId];
  const myAmount = myDeposit?.amount ?? 0;
  const lockup = myDeposit?.lockupRemaining ?? 0;

  const yieldPct = pool?.lastYieldPct ?? 0;
  const yieldMult = pool?.yieldMultiplier ?? 1;
  const depth = pool?.auctionDepthScore ?? 0;

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300 flex items-center">
        Insurance Pool
        <HelpHint text="Counter-cyclical yield: the KL divergence between actual and ideal auction fills drives a 1×–3× multiplier. Stressed markets pay depositors more, keeping capital locked during crises." />
      </span>

      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Yield</div>
          <div className="text-sm font-mono text-emerald-400">
            {yieldPct.toFixed(3)}%
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Mult</div>
          <div className="text-sm font-mono text-indigo-400">
            {yieldMult.toFixed(2)}×
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Depth</div>
          <div className="text-sm font-mono text-yellow-400">
            {depth.toFixed(3)}
          </div>
        </div>
      </div>

      <div className="text-[10px] font-mono text-gray-400">
        Total deposits: ${(pool?.totalDeposits ?? 0).toFixed(0)}
      </div>
      <div className="text-[10px] font-mono text-gray-400 flex justify-between">
        <span>Your stake:</span>
        <span className="text-gray-200">${myAmount.toFixed(2)}</span>
      </div>
      {lockup > 0 && (
        <div className="text-[10px] font-mono text-yellow-500">
          Lockup: {lockup} epochs remaining
        </div>
      )}

      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">
          Amount
        </label>
        <input
          type="range"
          min={100}
          max={Math.max(500, Math.floor(playerMargin * 0.5))}
          step={50}
          value={amount}
          onChange={(e) => setAmount(parseInt(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">
          ${amount}
        </span>
      </div>

      <div className="flex gap-1">
        <button
          disabled={amount > playerMargin}
          onClick={() => onDeposit?.(amount)}
          className="flex-1 text-[10px] font-mono py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Deposit
        </button>
        <button
          disabled={lockup > 0 || myAmount <= 0}
          onClick={() => onWithdraw?.(Math.min(amount, myAmount))}
          className="flex-1 text-[10px] font-mono py-1 rounded border border-red-700 text-red-300 hover:bg-red-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Withdraw
        </button>
      </div>
    </div>
  );
}
