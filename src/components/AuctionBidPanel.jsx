// AuctionBidPanel — auction-bid configuration only.
//
// Replaces the right-sidebar PlayerPanel (UI roadmap Phase 2). Wallet-
// state info (margin, P&L, LTV, capital breakdown) is now in the
// always-visible WalletStrip at the top of the page; this panel keeps
// only what's specific to active trading: the bid sliders + the
// transparent A/B classifier badge.
//
// Renders inside the Trade tab (where active trading lives) rather
// than as a globally-visible sidebar.

import { PRESETS } from "../constants/presets.js";
import { TipTierEditor } from "./TipTierEditor.jsx";
import { shouldUnwindCredit } from "../lib/credit.js";
import { HelpHint } from "./Tooltip.jsx";

const SIDES = ["LONG", "SHORT"];
const STRATEGIES = ["FIXED_LONG", "FIXED_SHORT", "YIELD_CHASER"];

// A/B class badge — fully transparent display of the user's
// classification, score breakdown, and the path to upgrading. This
// is the explicit fix for CFDs' hidden B-book conflict of interest.
function ClassBadge({ classifierStats }) {
  if (!classifierStats) return null;
  const isA = classifierStats.currentClass === "A";
  const cls = isA
    ? "border-emerald-700 bg-emerald-950 text-emerald-300"
    : "border-pink-700 bg-pink-950 text-pink-300";
  return (
    <div className={`flex flex-col gap-1 text-[10px] font-mono px-2 py-1 rounded border ${cls}`}>
      <div className="flex items-center justify-between">
        <span className="font-semibold flex items-center">
          Class {classifierStats.currentClass}
          <HelpHint
            width={340}
            text="Routing classification. A-class users peer-match through the auction; B-class users with unmatched bids fill via the B-book pool (an opt-in counterparty marketplace, not a hidden broker conflict). New users default to B; the score below is fully transparent and tells you exactly what flips you to A."
          />
        </span>
        <span className="text-gray-400">
          score {classifierStats.score >= 0 ? "+" : ""}
          {classifierStats.score.toFixed(2)}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1 text-[9px]">
        <span className="text-gray-400">
          win {(classifierStats.breakdown.winRate * 100).toFixed(0)}%
        </span>
        <span className="text-gray-400">
          avgR {(classifierStats.breakdown.avgReturn * 100).toFixed(1)}%
        </span>
        <span className="text-gray-400">
          n {classifierStats.closes}
        </span>
      </div>
      <div className="text-[9px] text-gray-500 leading-tight">
        {classifierStats.reasonText}
      </div>
    </div>
  );
}

export function AuctionBidPanel({
  player,
  onUpdate,
  activePair,
  cap,
  availablePoolCredit = 0,
  deployedPoolCredit = 0,
  classifierStats = null,
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

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Your Auction Bid
          <HelpHint
            width={340}
            text="Side / leverage / margin define your auction bid — they earn tip income when matched and drive A/B routing for explicit positions, but DON'T generate directional P&L on their own. Open a position via the Trade desk below to take actual exposure (LAP, paired LAP, or thread)."
          />
        </span>
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

      {/* Routing class — A/B classification with transparent score. */}
      <ClassBadge classifierStats={classifierStats} />

      {/* Two columns on wide screens to keep the panel compact. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Leverage — always ESMA-capped. */}
        {field("leverage", player.leverage ?? 1, 0.5, cap ?? 2, 0.25)}
        {/* Margin slider */}
        {field("margin", player.margin ?? 5000, 500, 50000, 500)}
      </div>

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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
      </div>

      {/* Tip tier editor */}
      <TipTierEditor
        tipTiers={player.tip_tiers ?? []}
        cap={cap ?? 2}
        onChange={(tiers) => onUpdate({ tip_tiers: tiers })}
      />

      <div className="text-[10px] font-mono text-gray-500 leading-tight border-t border-gray-800 pt-2">
        These controls set your auction bid — tips flow when matched, but
        directional exposure only comes from positions you open via the
        Trade desk below.
      </div>

      {(deployedPoolCredit > 0 || availablePoolCredit > 0) && (() => {
        const atFloor = shouldUnwindCredit(player.margin ?? 0, deployedPoolCredit);
        return (
          <div
            className={`text-[10px] font-mono text-center ${
              atFloor ? "text-red-400 animate-pulse" : "text-indigo-400"
            }`}
          >
            Pool credit · deployed ${deployedPoolCredit.toFixed(0)} · avail $
            {availablePoolCredit.toFixed(0)}
            {atFloor && " · HARD FLOOR"}
          </div>
        );
      })()}
    </div>
  );
}
