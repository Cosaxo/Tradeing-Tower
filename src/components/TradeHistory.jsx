// Ledger of closed trades with P&L.
export function TradeHistory({ trades = [] }) {
  if (trades.length === 0) {
    return (
      <div className="p-3 rounded border border-gray-700 bg-gray-900 text-[10px] font-mono text-gray-600">
        No closed trades yet.
      </div>
    );
  }

  const totalPnl = trades.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0).length;

  return (
    <div className="flex flex-col gap-1 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-mono text-gray-300">Trade History</span>
        <span className="text-[10px] font-mono text-gray-500">
          {trades.length} trades · {wins}W/{trades.length - wins}L
        </span>
      </div>

      <div className="text-[10px] font-mono flex justify-between pb-1 border-b border-gray-800">
        <span className="text-gray-500">Net P&L</span>
        <span
          style={{ color: totalPnl >= 0 ? "#34d399" : "#f87171" }}
        >
          {totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}
        </span>
      </div>

      <div className="max-h-64 overflow-y-auto flex flex-col gap-1">
        {[...trades].reverse().map((t, i) => {
          const pct = t.margin > 0 ? (t.pnl / t.margin) * 100 : 0;
          const color = (t.pnl ?? 0) >= 0 ? "#34d399" : "#f87171";
          return (
            <div
              key={i}
              className="flex items-center justify-between text-[10px] font-mono rounded border border-gray-800 bg-gray-950 px-2 py-1"
            >
              <div className="flex items-center gap-1 min-w-0">
                <span className="text-gray-200 truncate">{t.pairKey}</span>
                <span
                  className="px-1 rounded"
                  style={{
                    background: t.side === "LONG" ? "#14532d" : "#7f1d1d",
                    color: t.side === "LONG" ? "#86efac" : "#fca5a5",
                  }}
                >
                  {t.side}
                </span>
                <span className="text-gray-500">{t.leverage.toFixed(1)}×</span>
              </div>
              <div className="flex items-center gap-2 text-right">
                <span style={{ color }}>
                  {(t.pnl ?? 0) >= 0 ? "+" : ""}${(t.pnl ?? 0).toFixed(2)}
                </span>
                <span className="text-gray-500 w-12">
                  ({pct >= 0 ? "+" : ""}
                  {pct.toFixed(1)}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
