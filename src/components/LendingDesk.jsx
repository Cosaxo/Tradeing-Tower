// Lending desk: lenders post offers, borrowers match.
import { useState } from "react";

export function LendingDesk({
  playerId = "You",
  playerMargin,
  offers = [],
  borrows = [],
  yieldBuffer = 0,
  onPostOffer,
  onCancelOffer,
  onBorrow,
}) {
  const [mode, setMode] = useState("lend");
  const [amount, setAmount] = useState(500);
  const [rate, setRate] = useState(0.003);
  const [duration, setDuration] = useState(10);
  const [maxRate, setMaxRate] = useState(0.01);

  const myOffers = offers.filter((o) => o.lenderId === playerId && o.active);
  const myBorrows = borrows.filter((b) => b.borrowerId === playerId && b.active);
  const activeOffers = offers.filter((o) => o.active);

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">Lending Desk</span>
        <span className="text-[10px] font-mono text-indigo-400">
          buffer ${yieldBuffer.toFixed(0)}
        </span>
      </div>

      <div className="flex gap-1">
        {["lend", "borrow"].map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`flex-1 text-[10px] font-mono py-1 rounded border transition-colors ${
              mode === m
                ? "border-indigo-500 bg-indigo-950 text-indigo-200"
                : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-500"
            }`}
          >
            {m.toUpperCase()}
          </button>
        ))}
      </div>

      {mode === "lend" && (
        <>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 font-mono uppercase">
              Lend amount
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
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 font-mono uppercase">
              Rate / epoch
            </label>
            <input
              type="range"
              min={0.0005}
              max={0.02}
              step={0.0005}
              value={rate}
              onChange={(e) => setRate(parseFloat(e.target.value))}
              className="w-full accent-indigo-500"
            />
            <span className="text-[10px] font-mono text-gray-300 text-right">
              {(rate * 100).toFixed(3)}%
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 font-mono uppercase">
              Duration
            </label>
            <input
              type="range"
              min={2}
              max={30}
              step={1}
              value={duration}
              onChange={(e) => setDuration(parseInt(e.target.value))}
              className="w-full accent-indigo-500"
            />
            <span className="text-[10px] font-mono text-gray-300 text-right">
              {duration} epochs
            </span>
          </div>
          <button
            disabled={amount > playerMargin}
            onClick={() => onPostOffer?.({ amount, rate, duration })}
            className="text-[10px] font-mono py-1 rounded border border-emerald-700 text-emerald-300 hover:bg-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Post Offer
          </button>
          {myOffers.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1">
              <div className="text-[9px] font-mono text-gray-500">My offers</div>
              {myOffers.map((o) => (
                <div
                  key={o.id}
                  className="flex items-center justify-between text-[9px] font-mono rounded border border-gray-800 bg-gray-950 px-2 py-0.5"
                >
                  <span className="text-gray-300">
                    ${o.remaining}/{o.amount} @ {(o.rate * 100).toFixed(3)}%
                  </span>
                  <button
                    onClick={() => onCancelOffer?.(o.id)}
                    className="text-red-400 hover:text-red-300"
                  >
                    cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {mode === "borrow" && (
        <>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 font-mono uppercase">
              Borrow amount
            </label>
            <input
              type="range"
              min={100}
              max={5000}
              step={100}
              value={amount}
              onChange={(e) => setAmount(parseInt(e.target.value))}
              className="w-full accent-indigo-500"
            />
            <span className="text-[10px] font-mono text-gray-300 text-right">
              ${amount}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <label className="text-[10px] text-gray-500 font-mono uppercase">
              Max rate
            </label>
            <input
              type="range"
              min={0.001}
              max={0.03}
              step={0.001}
              value={maxRate}
              onChange={(e) => setMaxRate(parseFloat(e.target.value))}
              className="w-full accent-indigo-500"
            />
            <span className="text-[10px] font-mono text-gray-300 text-right">
              {(maxRate * 100).toFixed(2)}%
            </span>
          </div>
          <div className="text-[10px] font-mono text-gray-500">
            Available offers: {activeOffers.length}
          </div>
          <button
            disabled={activeOffers.length === 0}
            onClick={() => onBorrow?.({ amount, maxRate })}
            className="text-[10px] font-mono py-1 rounded border border-yellow-700 text-yellow-300 hover:bg-yellow-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            Match Borrow
          </button>
          {myBorrows.length > 0 && (
            <div className="flex flex-col gap-0.5 mt-1">
              <div className="text-[9px] font-mono text-gray-500">My borrows</div>
              {myBorrows.map((b) => (
                <div
                  key={b.id}
                  className="text-[9px] font-mono rounded border border-gray-800 bg-gray-950 px-2 py-0.5 text-gray-300"
                >
                  ${b.amount} @ {(b.rate * 100).toFixed(3)}% · {b.remaining} ep left
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
