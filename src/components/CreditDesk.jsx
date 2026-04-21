// Credit desk: displays credit assessment breakdown and qualification status.
export function CreditDesk({ assessment }) {
  if (!assessment) return null;

  const { creditScore, leverageExtension, qualified, breakdown } = assessment;
  const scoreColor = creditScore > 0.7 ? "#34d399" : creditScore > 0.4 ? "#fbbf24" : "#f87171";

  const metrics = [
    { label: "Sortino", key: "sor" },
    { label: "Calmar", key: "cal" },
    { label: "Win Rate", key: "wr" },
    { label: "Max DD", key: "dd" },
    { label: "Composition", key: "comp" },
    { label: "Drift", key: "drift", invert: true },
  ];

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300">Credit Desk</span>
        <span
          className="text-xs font-mono px-2 py-0.5 rounded"
          style={{ background: scoreColor + "22", color: scoreColor }}
        >
          {qualified ? "QUALIFIED" : "NOT QUALIFIED"}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Score</div>
          <div className="text-lg font-mono" style={{ color: scoreColor }}>
            {(creditScore * 100).toFixed(0)}
          </div>
        </div>
        <div className="text-center">
          <div className="text-[10px] text-gray-500 font-mono">Lev Extension</div>
          <div className="text-lg font-mono text-indigo-400">
            +{leverageExtension.toFixed(1)}×
          </div>
        </div>
      </div>

      <div className="grid grid-cols-6 gap-1">
        {metrics.map(({ label, key, invert }) => {
          const val = breakdown?.[key] ?? 0;
          // For drift, low is good so invert the barColor logic.
          const good = invert ? val < 0.3 : val > 0.7;
          const mid = invert ? val < 0.6 : val > 0.4;
          const barColor = good ? "#34d399" : mid ? "#fbbf24" : "#f87171";
          return (
            <div key={key} className="flex flex-col items-center gap-0.5">
              <div className="text-[9px] text-gray-500 font-mono">{label}</div>
              <div className="w-full h-8 bg-gray-800 rounded relative overflow-hidden">
                <div
                  className="absolute bottom-0 w-full rounded transition-all"
                  style={{ height: `${val * 100}%`, background: barColor + "88" }}
                />
              </div>
              <div className="text-[9px] font-mono" style={{ color: barColor }}>
                {(val * 100).toFixed(0)}
              </div>
            </div>
          );
        })}
      </div>

      {!qualified && (
        <div className="text-[10px] font-mono text-gray-500">
          Build a track record of 10+ epochs to qualify.
        </div>
      )}
    </div>
  );
}
