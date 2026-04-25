// LTV Desk — replaces the previous performance-gates Credit Desk.
//
// Now renders the same information that drives pool credit: the LTV
// number, its breakdown, and the structural stats it's derived from.
// The legacy parallel multiplier is gone; pool LTV is the only credit
// signal.
import { HelpHint } from "./Tooltip.jsx";
import {
  POOL_LTV_FLOOR,
  POOL_LTV_CEILING,
  POOL_LTV_TAIL_COVERAGE_TARGET,
} from "../lib/ltv.js";

const COMPONENTS = [
  { label: "Concentration (1 − HHI)", key: "concentrationComponent" },
  { label: "Diversity (Shannon)", key: "diversityComponent" },
  { label: "Tail coverage", key: "tailComponent" },
  { label: "Leverage discipline", key: "disciplineComponent" },
];

function ltvColor(ltv) {
  if (ltv >= 0.85) return "#34d399"; // emerald
  if (ltv >= 0.55) return "#fbbf24"; // amber
  return "#f87171";                   // red
}

export function CreditDesk({ poolLtv }) {
  if (!poolLtv) return null;

  const { ltv, breakdown, stats } = poolLtv;
  const c = ltvColor(ltv);

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          LTV Desk
          <HelpHint
            width={300}
            text={`Pool deposit LTV — the fraction of your deposit you can extract as pool-backed credit. Floor ${POOL_LTV_FLOOR.toFixed(2)} (untested or single concentrated position), ceiling ${POOL_LTV_CEILING.toFixed(2)} (broadly diversified, tail-hedged, low-leverage book). Five additive terms: concentration (1−HHI), asset-class diversity, tail coverage (≥${POOL_LTV_TAIL_COVERAGE_TARGET * 100}% in hedgeChar > 0.3 assets), leverage discipline, minus a max-weight penalty if any single position exceeds 50%.`}
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
          <div className="text-[10px] text-gray-500 font-mono">Pool LTV</div>
          <div className="text-2xl font-mono" style={{ color: c }}>
            {ltv.toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            floor {POOL_LTV_FLOOR.toFixed(2)} · cap {POOL_LTV_CEILING.toFixed(2)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Positions</div>
          <div className="text-xl font-mono text-gray-200">{stats.numPositions}</div>
          <div className="text-[9px] font-mono text-gray-600">
            {stats.numAssetClasses} class{stats.numAssetClasses === 1 ? "" : "es"}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">HHI</div>
          <div className="text-xl font-mono text-indigo-300">
            {stats.hhi.toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            max {(stats.maxWeight * 100).toFixed(0)}%
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Tail</div>
          <div className="text-xl font-mono text-gray-200">
            {(stats.tailFraction * 100).toFixed(0)}%
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            target {(POOL_LTV_TAIL_COVERAGE_TARGET * 100).toFixed(0)}%
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

      <div className="text-[10px] font-mono text-gray-500">
        Higher LTV → more pool credit available. Add asset classes, hedge with
        gold or volatility, keep leverage well below ESMA caps, and avoid one
        position dominating &gt; 50% of the book.
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
