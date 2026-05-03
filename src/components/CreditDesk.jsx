// LTV Desk — derived from the user's allocation across insurance
// markets, the reinsurance coverage they've bought, and how
// independent (uncorrelated) the underlying events are.
//
// Sprint 2: LTV → 1.0 only when reinsurance covers enough of each
// position AND positions are independent enough. Pure diversification
// alone caps below the ceiling — the user has to actually buy the
// hedge and choose uncorrelated exposures.
import { HelpHint } from "./Tooltip.jsx";
import {
  POOL_LTV_FLOOR,
  POOL_LTV_CEILING,
} from "../lib/ltv.js";

const COMPONENTS = [
  { label: "Concentration (1 − HHI)", key: "concentration" },
  { label: "Diversity (Shannon)", key: "diversity" },
  { label: "Breadth (markets covered)", key: "breadth" },
  { label: "Reinsurance coverage", key: "reinsuranceCoverage" },
  { label: "Independence (1 − avg ρ)", key: "independence" },
];

function ltvColor(ltv) {
  if (ltv >= 0.85) return "#34d399"; // emerald
  if (ltv >= 0.55) return "#fbbf24"; // amber
  return "#f87171";                   // red
}

export function CreditDesk({ poolLtv, tier3Gate = null }) {
  if (!poolLtv) return null;

  const { ltv, breakdown, stats } = poolLtv;
  const c = ltvColor(ltv);
  const gateOpen = tier3Gate?.open ?? false;
  const gateMissing = tier3Gate?.missing ?? [];

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      {/* Tier-3 gate banner. Sits at the top so users opening positions
          see the requirement before they hunt for the LTV breakdown. */}
      <div
        className={`rounded border px-3 py-2 flex items-start gap-2 ${
          gateOpen
            ? "border-emerald-800 bg-emerald-950/40"
            : "border-amber-800 bg-amber-950/30"
        }`}
      >
        <span
          className={`text-xs font-mono font-bold ${
            gateOpen ? "text-emerald-300" : "text-amber-300"
          }`}
        >
          {gateOpen ? "Tier 3 unlocked" : "Tier 3 locked"}
        </span>
        <span className="text-[10px] font-mono text-gray-400 leading-tight flex-1">
          {gateOpen
            ? "Active LAP exposure available — your allocations meet the diversification + reinsurance requirement."
            : `To unlock active trading: ${gateMissing.join(" · ")}`}
        </span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          LTV Desk
          <HelpHint
            width={320}
            text={`Allocation LTV — the fraction of your insurance-market stake you can extract as pool-backed credit. Floor ${POOL_LTV_FLOOR.toFixed(2)}, ceiling ${POOL_LTV_CEILING.toFixed(2)}. Five additive terms: concentration (1−HHI), Shannon diversity, breadth (markets touched), reinsurance coverage (face × coverageFraction / exposure), independence (1 − weighted average pairwise |ρ| across allocations). Minus a max-weight penalty if any single market > 50%. Reinsurance + independence dominate the rise toward the ceiling — pure diversification alone caps below.`}
          />
        </span>
        <span
          className="text-xs font-mono px-2 py-0.5 rounded"
          style={{ background: c + "22", color: c }}
        >
          LTV {ltv.toFixed(2)}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Allocation LTV</div>
          <div className="text-2xl font-mono" style={{ color: c }}>
            {ltv.toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            floor {POOL_LTV_FLOOR.toFixed(2)} · cap {POOL_LTV_CEILING.toFixed(2)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Markets</div>
          <div className="text-xl font-mono text-gray-200">{stats.numMarkets ?? 0}</div>
          <div className="text-[9px] font-mono text-gray-600">
            stake ${(stats.totalStake ?? 0).toFixed(0)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">HHI</div>
          <div className="text-xl font-mono text-indigo-300">
            {(stats.hhi ?? 1).toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            max {((stats.maxWeight ?? 1) * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Shannon</div>
          <div className="text-xl font-mono text-gray-200">
            {(stats.shannonNorm ?? 0).toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            normalised
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-gray-500 uppercase">
          LTV Breakdown
        </span>
        <div className="flex flex-col gap-0.5">
          <Row label="floor" value={breakdown.floor} positive />
          {COMPONENTS.map(({ label, key }) => (
            <Row key={key} label={label} value={breakdown[key]} positive />
          ))}
          <Row label="max-weight penalty" value={breakdown.maxWeightPenalty} positive={false} />
          <div className="flex justify-between text-[10px] font-mono pt-1 border-t border-gray-800">
            <span className="text-gray-300 uppercase">total LTV</span>
            <span className="font-bold" style={{ color: c }}>{ltv.toFixed(4)}</span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] font-mono text-gray-400 pt-1 border-t border-gray-800">
        <span>
          coverage{" "}
          <span className="text-emerald-300">
            {((stats.coverageRatio ?? 0) * 100).toFixed(0)}%
          </span>
        </span>
        <span>
          independence{" "}
          <span className="text-sky-300">
            {((stats.independenceScore ?? 0) * 100).toFixed(0)}%
          </span>
        </span>
      </div>

      <div className="text-[10px] font-mono text-gray-500">
        Higher LTV → more pool credit available. Spread across distinct
        underlying pairs (boosts independence), buy reinsurance to cover
        your insurer-side stake, and avoid any single market dominating
        &gt; 50% of your book.
      </div>
    </div>
  );
}

function Row({ label, value, positive }) {
  const sign = positive ? "+" : "−";
  const color = positive ? "#9ca3af" : "#f87171";
  return (
    <div className="flex justify-between text-[10px] font-mono">
      <span className="text-gray-400">{label}</span>
      <span style={{ color }}>
        {sign}{Math.abs(value).toFixed(4)}
      </span>
    </div>
  );
}
