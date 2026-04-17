// Portfolio structurer: shows per-pair credit eligibility, open positions,
// and allows opening/closing positions across multiple pairs.
import { PAIRS } from "../constants/assets.js";

export function PortfolioStructurer({ openPositions, creditEligibility, onOpen, onClose }) {
  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300">Portfolio Structurer</span>

      {(!openPositions || openPositions.length === 0) && (
        <span className="text-[10px] text-gray-600 font-mono">No open positions</span>
      )}

      {(openPositions ?? []).map((pos, i) => {
        const pair = PAIRS[pos.pairKey];
        const elig = creditEligibility?.[pos.pairKey];
        return (
          <div key={i} className="flex items-center justify-between gap-2 rounded border border-gray-800 bg-gray-950 px-2 py-1">
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1">
                <span className="text-xs font-mono text-gray-200">{pair?.symbol ?? pos.pairKey}</span>
                <span
                  className="text-[10px] font-mono px-1 rounded"
                  style={{ color: pos.side === "LONG" ? "#34d399" : "#f87171" }}
                >
                  {pos.side}
                </span>
                <span className="text-[10px] font-mono text-gray-500">{(pos.leverage ?? 1).toFixed(2)}×</span>
              </div>
              <div className="text-[10px] font-mono text-gray-500">
                ${ (pos.margin ?? 0).toFixed(0) }
                {elig && !elig.eligible && (
                  <span className="text-red-500 ml-1">({elig.reason})</span>
                )}
                {elig?.eligible && (
                  <span className="text-indigo-400 ml-1">credit ok</span>
                )}
              </div>
            </div>
            <button
              onClick={() => onClose?.(i)}
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-red-800 text-red-400 hover:bg-red-950 transition-colors"
            >
              close
            </button>
          </div>
        );
      })}

      <button
        onClick={() => onOpen?.()}
        className="text-[10px] font-mono px-2 py-1 rounded border border-indigo-700 text-indigo-300 hover:bg-indigo-950 transition-colors"
      >
        + Add Position
      </button>
    </div>
  );
}
