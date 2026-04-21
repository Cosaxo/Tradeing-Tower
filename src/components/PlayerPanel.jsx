// Player position configuration and live P&L readout.
import { PRESETS } from "../constants/presets.js";
import { TipTierEditor } from "./TipTierEditor.jsx";
import { shouldUnwindCredit } from "../lib/credit.js";
import { CapitalBreakdown } from "./CapitalBreakdown.jsx";

const SIDES = ["LONG", "SHORT"];
const STRATEGIES = ["FIXED_LONG", "FIXED_SHORT", "YIELD_CHASER"];

export function PlayerPanel({
  player,
  onUpdate,
  activePair,
  cap,
  creditScore,
  creditMultiplier = 0,
}) {
  function field(key, value, min, max, step = 0.1) {
    return (
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">{key}</label>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onUpdate({ [key]: parseFloat(e.target.value) })}
          className="w-full accent-indigo-500"
        />
        <span className="text-[10px] font-mono text-gray-300 text-right">{value}</span>
      </div>
    );
  }

  const pnlColor = (player.pnl ?? 0) >= 0 ? "text-emerald-400" : "text-red-400";
  const marginColor = player.margin >= 4000 ? "text-gray-200" : player.margin >= 2000 ? "text-yellow-400" : "text-red-400";

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">Your Position</span>
        {activePair && (
          <span className="text-[10px] font-mono text-indigo-400">{activePair}</span>
        )}
      </div>

      {/* Presets */}
      <div className="flex flex-wrap gap-1">
        {PRESETS.map((p) => (
          <button
            key={p.label}
            onClick={() => onUpdate(p.config)}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:border-indigo-500 hover:text-indigo-200 hover:bg-gray-700 transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-500">Margin</div>
          <div className={`text-sm font-mono ${marginColor}`}>${(player.margin ?? 5000).toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">P&L</div>
          <div className={`text-sm font-mono ${pnlColor}`}>
            {(player.pnl ?? 0) >= 0 ? "+" : ""}${(player.pnl ?? 0).toFixed(2)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500">Credit</div>
          <div className="text-sm font-mono text-indigo-400">{((creditScore ?? 0) * 100).toFixed(0)}%</div>
        </div>
      </div>

      {/* Capital breakdown — tags sharing the same margin (§10.1). */}
      <CapitalBreakdown margin={player.margin ?? 0} tags={player.tags ?? {}} />

      {/* Leverage — always ESMA-capped. Credit expands capital, not leverage (§10.5). */}
      {field("leverage", player.leverage ?? 1, 0.5, cap ?? 2, 0.25)}

      {/* Margin slider */}
      {field("margin", player.margin ?? 5000, 500, 50000, 500)}

      {/* Side select */}
      <div className="flex gap-1">
        {SIDES.map((s) => (
          <button
            key={s}
            onClick={() => onUpdate({ side: s, strategy: s === "LONG" ? "FIXED_LONG" : "FIXED_SHORT" })}
            aria-pressed={player.side === s}
            className={`flex-1 text-xs font-mono py-1 rounded border transition-colors ${
              player.side === s
                ? s === "LONG"
                  ? "border-emerald-500 bg-emerald-950 text-emerald-300"
                  : "border-red-500 bg-red-950 text-red-300"
                : "border-gray-700 bg-gray-800 text-gray-400 hover:border-gray-500 hover:bg-gray-700 hover:text-gray-200"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Strategy select */}
      <div className="flex flex-col gap-0.5">
        <label className="text-[10px] text-gray-500 font-mono uppercase">Strategy</label>
        <select
          value={player.strategy ?? "FIXED_LONG"}
          onChange={(e) => onUpdate({ strategy: e.target.value })}
          className="text-xs font-mono rounded border border-gray-700 bg-gray-800 text-gray-200 px-2 py-1"
        >
          {STRATEGIES.map((s) => (
            <option key={s} value={s}>{s.replace("_", " ")}</option>
          ))}
        </select>
      </div>

      {/* Min yield */}
      {field("minYield", player.minYield ?? 0, 0, 1, 0.05)}

      {/* Tip tier editor */}
      <TipTierEditor
        tipTiers={player.tip_tiers ?? []}
        cap={cap ?? 2}
        onChange={(tiers) => onUpdate({ tip_tiers: tiers })}
      />

      {player.liquidated && (
        <div className="text-center text-xs font-mono text-red-400 animate-pulse border border-red-800 rounded py-1">
          LIQUIDATED
        </div>
      )}

      {creditMultiplier > 1 && (() => {
        const deployed = (player.margin ?? 0) * (creditMultiplier - 1);
        const atFloor = shouldUnwindCredit(player.margin ?? 0, deployed);
        return (
          <div
            className={`text-[10px] font-mono text-center ${
              atFloor ? "text-red-400 animate-pulse" : "text-indigo-400"
            }`}
          >
            Credit {creditMultiplier.toFixed(2)}× · effective $
            {((player.margin ?? 0) * creditMultiplier).toFixed(0)}
            {atFloor && " · HARD FLOOR"}
          </div>
        );
      })()}
    </div>
  );
}
