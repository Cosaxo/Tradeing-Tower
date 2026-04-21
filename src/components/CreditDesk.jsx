// Credit Desk — whitepaper §7.4 faithful view.
// Shows:
//   - binary performance gates (all must pass)
//   - composition sub-scores (primary driver of multiplier)
//   - multiplier with baseline / cap / drift penalty
import { HelpHint } from "./Tooltip.jsx";

const GATE_LABELS = {
  window: "Window",
  sortino: "Sortino > 0.8",
  calmar: "Calmar > 0.5",
  maxDD: "DD < 15%",
  winRate: "WinRate > 48%",
  composition: "Comp > 0.2",
};

const COMP_SUBSCORES = [
  { label: "Hedge Balance", key: "hedge", weight: 0.3 },
  { label: "Concentration", key: "concentration", weight: 0.25 },
  { label: "Tail Coverage", key: "tail", weight: 0.2 },
  { label: "Diversity", key: "diversity", weight: 0.15 },
  { label: "Discipline", key: "discipline", weight: 0.1 },
];

export function CreditDesk({ assessment }) {
  if (!assessment) return null;

  const {
    qualified,
    multiplier,
    drift,
    deleveraging,
    deleverageEpochsRemaining,
    gates = {},
    composition,
    performance,
  } = assessment;

  const statusColor = qualified
    ? deleveraging ? "#fbbf24" : "#34d399"
    : "#f87171";
  const statusLabel = qualified
    ? deleveraging ? "DELEVERAGING" : "QUALIFIED"
    : "NOT QUALIFIED";

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Credit Desk
          <HelpHint
            width={280}
            text="Credit rewards how your portfolio is BUILT, not how it recently performed. All 5 performance gates must pass; composition drives the multiplier magnitude via hedge balance, HHI concentration, tail coverage (>15% in hedgeChar>0.3 assets), asset-class diversity, and leverage discipline."
          />
        </span>
        <span
          className="text-xs font-mono px-2 py-0.5 rounded"
          style={{ background: statusColor + "22", color: statusColor }}
        >
          {statusLabel}
        </span>
      </div>

      <div className="flex items-center gap-4">
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Multiplier</div>
          <div className="text-2xl font-mono" style={{ color: statusColor }}>
            {multiplier.toFixed(2)}×
          </div>
          <div className="text-[9px] font-mono text-gray-600">cap 2.5×</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Composition</div>
          <div className="text-xl font-mono text-indigo-300">
            {(composition?.score ?? 0).toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">weight 70%</div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Performance</div>
          <div className="text-xl font-mono text-gray-300">
            {(performance?.score ?? 0).toFixed(2)}
          </div>
          <div className="text-[9px] font-mono text-gray-600">weight 30%</div>
        </div>
        {drift > 0 && (
          <div className="text-center">
            <div className="text-[10px] text-gray-500 font-mono">Drift</div>
            <div
              className="text-xl font-mono"
              style={{ color: drift > 0.5 ? "#fbbf24" : "#9ca3af" }}
            >
              {(drift * 100).toFixed(0)}%
            </div>
            {deleveraging && (
              <div className="text-[9px] font-mono text-yellow-400">
                {deleverageEpochsRemaining}ep left
              </div>
            )}
          </div>
        )}
      </div>

      {/* Binary performance gates */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-gray-500 uppercase">Performance Gates</span>
        <div className="grid grid-cols-3 gap-1">
          {Object.entries(GATE_LABELS).map(([key, label]) => {
            const pass = gates[key] === true;
            const color = pass ? "#34d399" : "#f87171";
            return (
              <div
                key={key}
                className="flex items-center gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-1"
              >
                <span
                  className="w-2 h-2 rounded-full inline-block shrink-0"
                  style={{ background: color }}
                />
                <span className="text-[9px] font-mono" style={{ color }}>
                  {label}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Composition sub-scores */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-gray-500 uppercase flex items-center">
          Composition Sub-scores
          <HelpHint
            width={260}
            text="Hedge Balance (W=30%): net hedgeChar near 0. Concentration (25%): HHI below 0.25. Tail Coverage (20%): ≥15% in hedgeChar>0.3 assets (GOLD, VIX, TAIL, etc). Diversity (15%): Shannon entropy of asset classes. Discipline (10%): leverage well below ESMA cap."
          />
        </span>
        <div className="grid grid-cols-5 gap-1">
          {COMP_SUBSCORES.map(({ label, key, weight }) => {
            const val = composition?.breakdown?.[key] ?? 0;
            const color = val > 0.7 ? "#34d399" : val > 0.4 ? "#fbbf24" : "#f87171";
            return (
              <div key={key} className="flex flex-col items-center gap-0.5">
                <div className="text-[9px] text-gray-500 font-mono text-center truncate w-full" title={label}>
                  {label}
                </div>
                <div className="w-full h-8 bg-gray-800 rounded relative overflow-hidden">
                  <div
                    className="absolute bottom-0 w-full rounded transition-all"
                    style={{ height: `${val * 100}%`, background: color + "88" }}
                  />
                </div>
                <div className="text-[9px] font-mono" style={{ color }}>
                  {(val * 100).toFixed(0)}
                </div>
                <div className="text-[8px] font-mono text-gray-600">
                  ×{weight.toFixed(2)}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!qualified && (
        <div className="text-[10px] font-mono text-gray-500">
          Fix any failed gate above to qualify. The multiplier then depends
          primarily on how balanced, diversified, and tail-covered your book is.
        </div>
      )}
    </div>
  );
}
