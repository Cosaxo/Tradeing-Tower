// Horizontal timeline of regime transitions for one pair.
export function RegimeTimeline({ history = [], currentRegime, currentEpoch = 0 }) {
  if (!history || history.length === 0) {
    return (
      <div className="p-3 rounded border border-gray-700 bg-gray-900 text-[10px] font-mono text-gray-600">
        Regime steady — no transitions recorded.
      </div>
    );
  }

  const firstEpoch = history[0].epoch;
  const span = Math.max(1, currentEpoch - firstEpoch);

  return (
    <div className="p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-mono text-gray-300">Regime Timeline</span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded"
          style={{
            background: (currentRegime?.color ?? "#374151") + "22",
            color: currentRegime?.color ?? "#9ca3af",
          }}
        >
          now: {currentRegime?.label ?? "—"}
        </span>
      </div>

      {/* Segmented bar */}
      <div className="relative h-6 rounded overflow-hidden bg-gray-800">
        {history.map((r, i) => {
          const start = r.epoch - firstEpoch;
          const end = i + 1 < history.length ? history[i + 1].epoch - firstEpoch : span;
          const leftPct = (start / span) * 100;
          const widthPct = Math.max(1, ((end - start) / span) * 100);
          return (
            <div
              key={i}
              className="absolute top-0 bottom-0 text-[9px] font-mono flex items-center justify-center px-1 overflow-hidden"
              style={{
                left: `${leftPct}%`,
                width: `${widthPct}%`,
                background: (r.color ?? "#374151") + "66",
                color: r.color ?? "#9ca3af",
                borderRight: "1px solid rgba(0,0,0,0.4)",
              }}
              title={`Epoch ${r.epoch}: ${r.label}`}
            >
              {widthPct > 8 ? r.label : ""}
            </div>
          );
        })}
      </div>

      <div className="flex justify-between mt-1 text-[9px] font-mono text-gray-600">
        <span>epoch {firstEpoch}</span>
        <span>{history.length} transitions</span>
        <span>epoch {currentEpoch}</span>
      </div>
    </div>
  );
}
