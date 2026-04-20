// Strip desk — buy yield strip (loss protection) contracts.
import { useState } from "react";
import { calcStripPremium } from "../lib/yieldModel.js";

export function StripDesk({
  playerMargin,
  leverage,
  realizedSigma,
  returnHistory = [],
  onBuyStrip,
  openStrips = [],
}) {
  const [threshold, setThreshold] = useState(0.2);
  const [protectedFraction, setProtectedFraction] = useState(0.5);
  const [epochs, setEpochs] = useState(10);

  const premium = calcStripPremium(
    leverage,
    realizedSigma,
    threshold,
    protectedFraction,
    returnHistory
  );
  const stripCost = playerMargin * premium;

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">Strip Desk</span>
        <span className="text-[10px] font-mono text-gray-500">
          {openStrips.length} open
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">
          Loss threshold
        </label>
        <input
          type="range"
          min={0.05}
          max={0.5}
          step={0.05}
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">
          {(threshold * 100).toFixed(0)}%
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">
          Protected fraction
        </label>
        <input
          type="range"
          min={0.1}
          max={0.8}
          step={0.1}
          value={protectedFraction}
          onChange={(e) => setProtectedFraction(parseFloat(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">
          {(protectedFraction * 100).toFixed(0)}%
        </span>
      </div>

      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">
          Duration (epochs)
        </label>
        <input
          type="range"
          min={2}
          max={30}
          step={1}
          value={epochs}
          onChange={(e) => setEpochs(parseInt(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">
          {epochs}
        </span>
      </div>

      <div className="text-[10px] font-mono text-gray-400 flex justify-between">
        <span>Premium rate:</span>
        <span className="text-indigo-300">{(premium * 100).toFixed(3)}%</span>
      </div>

      <button
        disabled={stripCost > playerMargin * 0.3}
        onClick={() =>
          onBuyStrip?.({
            leverage,
            margin: playerMargin,
            epochs,
            threshold,
            protectedFraction,
            realizedSigma,
            returnHistory,
          })
        }
        className="text-[10px] font-mono py-1 rounded border border-blue-700 text-blue-300 hover:bg-blue-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        Buy Strip — ${stripCost.toFixed(2)}
      </button>
    </div>
  );
}
