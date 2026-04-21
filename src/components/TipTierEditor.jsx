// Compact editor for the player's tip-tier curve.
// A tier = { lev_start, lev_end, tip, fill_direction }.
export function TipTierEditor({ tipTiers = [], cap = 2, onChange }) {
  function updateTier(i, patch) {
    const next = tipTiers.map((t, idx) => (idx === i ? { ...t, ...patch } : t));
    onChange?.(next);
  }

  function addTier() {
    onChange?.([
      ...tipTiers,
      {
        lev_start: Math.max(1, tipTiers[tipTiers.length - 1]?.lev_end ?? 1),
        lev_end: Math.min(cap, (tipTiers[tipTiers.length - 1]?.lev_end ?? 1) + 1),
        tip: 0.02,
        fill_direction: "bottom-up",
      },
    ]);
  }

  function removeTier(i) {
    onChange?.(tipTiers.filter((_, idx) => idx !== i));
  }

  return (
    <div className="flex flex-col gap-1 p-2 rounded border border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-gray-400">Tip Tiers</span>
        <button
          onClick={addTier}
          className="text-[9px] font-mono px-1.5 py-0.5 rounded border border-indigo-700 text-indigo-300 hover:bg-indigo-950 transition-colors"
        >
          + tier
        </button>
      </div>

      {tipTiers.length === 0 && (
        <span className="text-[10px] font-mono text-gray-600">no tiers set</span>
      )}

      {tipTiers.map((t, i) => (
        <div key={i} className="flex flex-col gap-0.5 rounded border border-gray-800 px-1.5 py-1">
          <div className="flex items-center justify-between">
            <span className="text-[9px] font-mono text-gray-500">
              tier {i + 1} · {t.fill_direction}
            </span>
            <button
              onClick={() => removeTier(i)}
              className="text-[9px] font-mono text-red-400 hover:text-red-200 hover:bg-red-950/50 px-2 py-0.5 rounded transition-colors"
              aria-label={`Remove tier ${i + 1}`}
            >
              ×
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1 text-[9px] font-mono">
            <label className="flex flex-col">
              <span className="text-gray-600">start</span>
              <input
                type="number"
                min={0.5}
                max={cap}
                step={0.1}
                value={t.lev_start}
                onChange={(e) => updateTier(i, { lev_start: parseFloat(e.target.value) })}
                className="rounded bg-gray-900 border border-gray-700 px-1 py-0.5 text-gray-200"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-gray-600">end</span>
              <input
                type="number"
                min={0.5}
                max={cap}
                step={0.1}
                value={t.lev_end}
                onChange={(e) => updateTier(i, { lev_end: parseFloat(e.target.value) })}
                className="rounded bg-gray-900 border border-gray-700 px-1 py-0.5 text-gray-200"
              />
            </label>
            <label className="flex flex-col">
              <span className="text-gray-600">tip</span>
              <input
                type="number"
                min={0}
                max={0.3}
                step={0.005}
                value={t.tip}
                onChange={(e) => updateTier(i, { tip: parseFloat(e.target.value) })}
                className="rounded bg-gray-900 border border-gray-700 px-1 py-0.5 text-gray-200"
              />
            </label>
          </div>
          <select
            value={t.fill_direction}
            onChange={(e) => updateTier(i, { fill_direction: e.target.value })}
            className="text-[9px] font-mono rounded bg-gray-900 border border-gray-700 px-1 py-0.5 text-gray-300"
          >
            <option value="bottom-up">bottom-up</option>
            <option value="top-down">top-down</option>
          </select>
        </div>
      ))}
    </div>
  );
}
