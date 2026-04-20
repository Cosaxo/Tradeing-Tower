// Contract desk — buy imbalance or entropy LAP-native contracts.
import { useState } from "react";
import {
  calcImbalancePremium,
  calcEntropyContractPremium,
} from "../lib/contracts.js";

export function ContractDesk({
  longMargin,
  shortMargin,
  normWeights = [],
  avgEntropyMult = 1,
  playerMargin,
  onBuyImbalance,
  onBuyEntropy,
  openImbalance = [],
  openEntropy = [],
}) {
  const [size, setSize] = useState(500);
  const [direction, setDirection] = useState("LONG");
  const [strikeImb, setStrikeImb] = useState(0.3);
  const [lockedMult, setLockedMult] = useState(1.2);

  const imbPremium = calcImbalancePremium(longMargin, shortMargin);
  const entPremium = calcEntropyContractPremium(normWeights, lockedMult);
  const canAfford = (price) => size * price <= playerMargin * 0.3;

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300">Contract Desk</span>

      {/* Size slider (shared) */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">
          Contract size
        </label>
        <input
          type="range"
          min={100}
          max={5000}
          step={100}
          value={size}
          onChange={(e) => setSize(parseInt(e.target.value))}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">
          ${size}
        </span>
      </div>

      {/* Imbalance contract */}
      <div className="flex flex-col gap-1.5 rounded border border-gray-800 bg-gray-950 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-gray-300">
            Imbalance Contract
          </span>
          <span className="text-[10px] font-mono text-indigo-400">
            prem {(imbPremium * 100).toFixed(3)}%
          </span>
        </div>
        <div className="flex gap-1">
          {["LONG", "SHORT"].map((d) => (
            <button
              key={d}
              onClick={() => setDirection(d)}
              className={`flex-1 text-[10px] font-mono py-0.5 rounded border ${
                direction === d
                  ? d === "LONG"
                    ? "border-emerald-500 bg-emerald-950 text-emerald-300"
                    : "border-red-500 bg-red-950 text-red-300"
                  : "border-gray-700 bg-gray-800 text-gray-400"
              }`}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-gray-500 font-mono">strike</span>
          <input
            type="range"
            min={0.1}
            max={0.9}
            step={0.05}
            value={strikeImb}
            onChange={(e) => setStrikeImb(parseFloat(e.target.value))}
            className="flex-1 accent-indigo-500"
          />
          <span className="text-[9px] font-mono text-gray-300 w-10 text-right">
            {strikeImb.toFixed(2)}
          </span>
        </div>
        <button
          disabled={!canAfford(imbPremium)}
          onClick={() =>
            onBuyImbalance?.({
              size,
              direction,
              strikeImbalance: strikeImb,
              premium: imbPremium,
            })
          }
          className="text-[10px] font-mono py-1 rounded border border-indigo-700 text-indigo-300 hover:bg-indigo-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Buy — ${(size * imbPremium).toFixed(2)}
        </button>
        {openImbalance.length > 0 && (
          <div className="text-[9px] font-mono text-gray-500">
            {openImbalance.length} open
          </div>
        )}
      </div>

      {/* Entropy contract */}
      <div className="flex flex-col gap-1.5 rounded border border-gray-800 bg-gray-950 p-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] font-mono text-gray-300">
            Entropy Contract
          </span>
          <span className="text-[10px] font-mono text-indigo-400">
            prem {(entPremium * 100).toFixed(3)}%
          </span>
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[9px] text-gray-500 font-mono">lock</span>
          <input
            type="range"
            min={1.0}
            max={3.0}
            step={0.1}
            value={lockedMult}
            onChange={(e) => setLockedMult(parseFloat(e.target.value))}
            className="flex-1 accent-indigo-500"
          />
          <span className="text-[9px] font-mono text-gray-300 w-10 text-right">
            {lockedMult.toFixed(1)}×
          </span>
        </div>
        <div className="text-[9px] font-mono text-gray-500">
          Current multiplier: {avgEntropyMult.toFixed(2)}×
        </div>
        <button
          disabled={!canAfford(entPremium)}
          onClick={() =>
            onBuyEntropy?.({
              size,
              lockedMult,
              premium: entPremium,
            })
          }
          className="text-[10px] font-mono py-1 rounded border border-fuchsia-700 text-fuchsia-300 hover:bg-fuchsia-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          Buy — ${(size * entPremium).toFixed(2)}
        </button>
        {openEntropy.length > 0 && (
          <div className="text-[9px] font-mono text-gray-500">
            {openEntropy.length} open
          </div>
        )}
      </div>
    </div>
  );
}
