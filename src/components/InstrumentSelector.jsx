// Instrument selector: pick which pair is active + shows basic stats per pair.
import { PAIRS, ASSET_CLASSES, ACTIVE_PAIRS } from "../constants/assets.js";
import { Sparkline } from "./Sparkline.jsx";

export function InstrumentSelector({ activePair, onSelect, pairStates }) {
  return (
    <div className="flex flex-col gap-1 overflow-y-auto max-h-[calc(100vh-8rem)]">
      {ACTIVE_PAIRS.map((pk) => {
        const pair = PAIRS[pk];
        const ps = pairStates?.[pk];
        const cls = ASSET_CLASSES[pair?.assetClass];
        const prices = ps?.prices ?? [];
        const latest = prices[prices.length - 1] ?? pair?.startPrice ?? 0;
        const first = prices[0] ?? latest;
        const pct = first > 0 ? ((latest - first) / first) * 100 : 0;
        const isActive = pk === activePair;

        return (
          <button
            key={pk}
            onClick={() => onSelect(pk)}
            className={`text-left rounded px-2 py-1.5 border transition-colors ${
              isActive
                ? "border-indigo-500 bg-indigo-950"
                : "border-gray-700 bg-gray-900 hover:border-gray-500"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm">{pair?.flag ?? ""}</span>
                <span className="text-xs font-mono text-gray-200 truncate">{pair?.symbol}</span>
                {cls && (
                  <span
                    className="text-[10px] px-1 rounded"
                    style={{ background: cls.color + "22", color: cls.color }}
                  >
                    {cls.esmaMaxLev}×
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Sparkline
                  data={prices.slice(-30)}
                  width={48}
                  height={18}
                  color={pair?.color ?? "#6b7280"}
                />
                <span
                  className="text-[10px] font-mono w-12 text-right"
                  style={{ color: pct >= 0 ? "#34d399" : "#f87171" }}
                >
                  {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                </span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
