// Cross-pair correlation matrix heatmap.
import { PAIRS } from "../constants/assets.js";
import { getPairCorr } from "../lib/correlation.js";

function cellColor(rho) {
  const v = Math.max(-1, Math.min(1, rho));
  if (v >= 0) {
    const g = Math.round(200 * v);
    return `rgb(${20 + g}, ${100 + g * 0.5}, ${30})`;
  } else {
    const r = Math.round(200 * -v);
    return `rgb(${30 + r}, ${20}, ${20 + r * 0.2})`;
  }
}

export function CorrelationHeatmap({ corrMap, pairs = [] }) {
  if (!corrMap || pairs.length === 0) {
    return (
      <div className="p-3 rounded border border-gray-700 bg-gray-900 text-[10px] font-mono text-gray-600">
        No correlation data — run slow epochs to populate.
      </div>
    );
  }

  const shown = pairs.slice(0, 12);

  return (
    <div className="p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-gray-300">Correlation Heatmap</span>
        <span className="text-[9px] font-mono text-gray-500">
          green = positive · red = negative
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="border-collapse">
          <thead>
            <tr>
              <th className="text-[9px] font-mono text-gray-500 p-0.5"></th>
              {shown.map((p) => (
                <th
                  key={p}
                  className="text-[9px] font-mono text-gray-400 p-0.5 writing-vertical"
                  style={{ writingMode: "vertical-rl", transform: "rotate(180deg)" }}
                >
                  {PAIRS[p]?.symbol ?? p}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row}>
                <td className="text-[9px] font-mono text-gray-400 p-0.5 pr-2 whitespace-nowrap">
                  {PAIRS[row]?.symbol ?? row}
                </td>
                {shown.map((col) => {
                  const rho = row === col ? 1 : getPairCorr(corrMap, row, col);
                  return (
                    <td
                      key={col}
                      className="w-5 h-5 border border-gray-950 text-[8px] font-mono text-center"
                      style={{
                        background: cellColor(rho),
                        color: Math.abs(rho) > 0.5 ? "#fff" : "#cbd5e1",
                      }}
                      title={`${row} × ${col} = ${rho.toFixed(3)}`}
                    >
                      {rho.toFixed(1)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
