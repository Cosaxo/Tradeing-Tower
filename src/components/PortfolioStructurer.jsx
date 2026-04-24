// Portfolio structurer: shows per-pair credit eligibility, open positions,
// and allows opening/closing positions — either from the user's own
// margin (direct path) or funded by pool credit (pool-backed path).
import { PAIRS } from "../constants/assets.js";
import { HelpHint } from "./Tooltip.jsx";

export function PortfolioStructurer({
  openPositions,
  creditEligibility,
  onOpen,
  onClose,
  poolLtv = null,
  availablePoolCredit = 0,
  poolDepositAmount = 0,
  deployedPoolCredit = 0,
}) {
  const hasPool = poolDepositAmount > 0;

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300 flex items-center">
        Portfolio Structurer
        <HelpHint
          width={280}
          text="Open LAPs from direct margin (tagged as auction collateral) or funded by pool credit. Pool-funded LAPs are tethered to your deposit: if either side loses, the haircut propagates — on a lagged tick, so the two subsystems never mutate the same slice in one frame."
        />
      </span>

      {hasPool && (
        <div className="flex flex-col gap-1 rounded border border-indigo-900 bg-indigo-950/30 px-2 py-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-indigo-300 uppercase">
              Pool Credit
            </span>
            <span className="text-[10px] font-mono text-indigo-200">
              LTV {(poolLtv?.ltv ?? 0).toFixed(2)}
            </span>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center">
            <div>
              <div className="text-[10px] text-gray-500">Deposit</div>
              <div className="text-xs font-mono text-gray-200">
                ${poolDepositAmount.toFixed(0)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">Deployed</div>
              <div className="text-xs font-mono text-amber-300">
                ${deployedPoolCredit.toFixed(0)}
              </div>
            </div>
            <div>
              <div className="text-[10px] text-gray-500">Available</div>
              <div className="text-xs font-mono text-emerald-300">
                ${availablePoolCredit.toFixed(0)}
              </div>
            </div>
          </div>
          {poolLtv?.stats && (
            <div className="text-[10px] font-mono text-gray-500">
              {poolLtv.stats.numPositions} pos · {poolLtv.stats.numAssetClasses} classes · HHI{" "}
              {poolLtv.stats.hhi.toFixed(2)} · max{" "}
              {(poolLtv.stats.maxWeight * 100).toFixed(0)}%
            </div>
          )}
        </div>
      )}

      {(!openPositions || openPositions.length === 0) && (
        <span className="text-[10px] text-gray-600 font-mono">No open positions</span>
      )}

      {(openPositions ?? []).map((pos, i) => {
        const pair = PAIRS[pos.pairKey];
        const elig = creditEligibility?.[pos.pairKey];
        const isPoolBacked = !!pos.poolLinkage;
        return (
          <div
            key={i}
            className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${
              isPoolBacked
                ? "border-indigo-800 bg-indigo-950/40"
                : "border-gray-800 bg-gray-950"
            }`}
          >
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
                {isPoolBacked && (
                  <span className="text-[10px] font-mono px-1 rounded border border-indigo-700 bg-indigo-950 text-indigo-300">
                    pool
                  </span>
                )}
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
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-red-800 text-red-400 hover:text-red-200 hover:bg-red-950 transition-colors"
              aria-label={`Close ${pair?.symbol ?? pos.pairKey} ${pos.side}`}
            >
              close
            </button>
          </div>
        );
      })}

      <div className="flex gap-1">
        <button
          onClick={() => onOpen?.({ usePoolCredit: false })}
          className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:text-gray-100 hover:bg-gray-700 hover:border-gray-500 transition-colors"
        >
          + Direct (own margin)
        </button>
        <button
          onClick={() => onOpen?.({ usePoolCredit: true })}
          disabled={!hasPool || availablePoolCredit <= 0}
          className="flex-1 text-[10px] font-mono px-2 py-1 rounded border border-indigo-700 bg-indigo-950 text-indigo-300 hover:text-indigo-100 hover:bg-indigo-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          title={!hasPool ? "Deposit into the pool first" : availablePoolCredit <= 0 ? "No pool credit available" : ""}
        >
          + Pool credit (${availablePoolCredit.toFixed(0)})
        </button>
      </div>
    </div>
  );
}
