// Performance metrics dashboard.
// Displays equity curve + Sortino/Calmar/WinRate/MaxDD.
import { useMemo } from "react";
import {
  sortino,
  calcCalmar,
  calcWinRate,
  calcMaxDrawdown,
  calcReturns,
} from "../lib/math.js";
import { Sparkline } from "./Sparkline.jsx";
import { HelpHint } from "./Tooltip.jsx";

export function MetricsPanel({ equityHistory = [] }) {
  const metrics = useMemo(() => {
    if (equityHistory.length < 2) return null;
    const history = equityHistory.map((e) => ({
      users: [{ id: "You", margin: e }],
    }));
    const returns = calcReturns(history);
    const maxDD = calcMaxDrawdown(history);
    return {
      sortino: sortino(returns) ?? 0,
      calmar: calcCalmar(returns, maxDD) ?? 0,
      winRate: calcWinRate(returns) ?? 0.5,
      maxDD,
      totalReturn:
        equityHistory[0] > 0
          ? (equityHistory[equityHistory.length - 1] - equityHistory[0]) /
            equityHistory[0]
          : 0,
    };
  }, [equityHistory]);

  const currentEquity = equityHistory[equityHistory.length - 1] ?? 0;
  const peak = equityHistory.length > 0 ? Math.max(...equityHistory) : 0;

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Performance
          <HelpHint text="Sortino = mean return / downside deviation. Calmar = return / max drawdown. MaxDD = largest peak-to-trough equity loss. Higher Sortino + Calmar + win rate feeds into the Credit Desk." />
        </span>
        <span className="text-[10px] font-mono text-gray-500">
          {equityHistory.length} epochs
        </span>
      </div>

      <div className="flex items-center gap-3">
        <Sparkline
          data={equityHistory}
          width={180}
          height={40}
          color={
            metrics?.totalReturn >= 0 ? "#34d399" : "#f87171"
          }
          strokeWidth={2}
        />
        <div className="flex flex-col">
          <div className="text-[10px] text-gray-500 font-mono">Equity</div>
          <div className="text-lg font-mono text-gray-100">
            ${currentEquity.toFixed(0)}
          </div>
          <div
            className="text-[10px] font-mono"
            style={{
              color: (metrics?.totalReturn ?? 0) >= 0 ? "#34d399" : "#f87171",
            }}
          >
            {(metrics?.totalReturn ?? 0) >= 0 ? "+" : ""}
            {((metrics?.totalReturn ?? 0) * 100).toFixed(2)}%
          </div>
        </div>
      </div>

      {metrics && (
        <div className="grid grid-cols-4 gap-2">
          <Stat label="Sortino" value={metrics.sortino.toFixed(2)} good={metrics.sortino > 1} />
          <Stat label="Calmar" value={metrics.calmar.toFixed(2)} good={metrics.calmar > 0.5} />
          <Stat
            label="Win Rate"
            value={`${(metrics.winRate * 100).toFixed(0)}%`}
            good={metrics.winRate > 0.5}
          />
          <Stat
            label="Max DD"
            value={`${(metrics.maxDD * 100).toFixed(1)}%`}
            good={metrics.maxDD < 0.2}
          />
        </div>
      )}

      <div className="text-[10px] font-mono text-gray-500">
        Peak: ${peak.toFixed(0)}
      </div>
    </div>
  );
}

function Stat({ label, value, good }) {
  return (
    <div className="text-center">
      <div className="text-[10px] text-gray-500 font-mono">{label}</div>
      <div
        className="text-sm font-mono"
        style={{ color: good ? "#34d399" : "#fbbf24" }}
      >
        {value}
      </div>
    </div>
  );
}
