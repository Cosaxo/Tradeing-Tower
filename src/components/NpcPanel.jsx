// Visualize NPC traders in the active pair.
// Shows strategy, leverage, and bias so the player can see what the book looks like.
export function NpcPanel({ npcs = [] }) {
  if (!npcs || npcs.length === 0) {
    return (
      <div className="p-3 rounded border border-gray-700 bg-gray-900 text-[10px] font-mono text-gray-600">
        No NPCs active
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300 mb-1">NPC Book</span>

      {npcs.map((n) => {
        const isLong = n.strategy?.includes("LONG");
        const isShort = n.strategy?.includes("SHORT");
        const color = isLong ? "#34d399" : isShort ? "#f87171" : "#fbbf24";

        const tip = n.tip_tiers?.[0]?.tip ?? 0;

        return (
          <div
            key={n.id}
            className="flex items-center justify-between gap-2 text-[10px] font-mono rounded border border-gray-800 bg-gray-950 px-2 py-1"
          >
            <div className="flex items-center gap-1 min-w-0">
              <span className="text-gray-200 w-16 truncate">{n.id}</span>
              <span
                className="px-1 rounded"
                style={{ background: color + "22", color }}
              >
                {n.strategy?.replace("FIXED_", "").replace("_", " ")}
              </span>
            </div>
            <div className="flex items-center gap-2 text-gray-400">
              <span>{n.max_lev?.toFixed(1)}×</span>
              <span>${(n.base_margin / 1000).toFixed(1)}k</span>
              <span className="text-indigo-400">
                {(tip * 100).toFixed(2)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
