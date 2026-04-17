// Stress panel: solvency buffer + shock scenario results.
export function StressPanel({ solvency, shockResults, onRunShock }) {
  const bufferColor =
    !solvency ? "#6b7280"
    : solvency.solvencyBuffer > 0.5 ? "#34d399"
    : solvency.solvencyBuffer > 0.2 ? "#fbbf24"
    : "#f87171";

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">Stress Test</span>
        {onRunShock && (
          <button
            onClick={onRunShock}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-yellow-700 text-yellow-400 hover:bg-yellow-950 transition-colors"
          >
            Run −20% Shock
          </button>
        )}
      </div>

      {solvency && (
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="text-[10px] text-gray-500 font-mono">Buffer</div>
            <div className="text-sm font-mono" style={{ color: bufferColor }}>
              {(solvency.solvencyBuffer * 100).toFixed(1)}%
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 font-mono">Exposure</div>
            <div className="text-sm font-mono text-gray-300">
              ${(solvency.totalExposure / 1000).toFixed(1)}k
            </div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 font-mono">Margin</div>
            <div className="text-sm font-mono text-gray-300">
              ${(solvency.totalMargin / 1000).toFixed(1)}k
            </div>
          </div>
        </div>
      )}

      {shockResults && (
        <div className="flex flex-col gap-1">
          <div className="text-[10px] font-mono text-gray-400">
            Shock scenario: {shockResults.liquidated} liquidations / ${shockResults.systemLoss?.toFixed(0)} loss
          </div>
          <div className="grid grid-cols-2 gap-1">
            {(shockResults.positions ?? []).slice(0, 6).map((p, i) => (
              <div
                key={i}
                className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                style={{
                  background: p.liquidated ? "#7f1d1d" : "#14532d",
                  color: p.liquidated ? "#fca5a5" : "#86efac",
                }}
              >
                {p.pairKey} {p.side} {p.liquidated ? "LIQ" : "ok"}
              </div>
            ))}
          </div>
        </div>
      )}

      {!solvency && (
        <div className="text-[10px] font-mono text-gray-600">
          Run simulation to see solvency data.
        </div>
      )}
    </div>
  );
}
