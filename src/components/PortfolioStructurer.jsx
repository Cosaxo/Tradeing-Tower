// Portfolio structurer: shows per-pair credit eligibility, open positions,
// and allows opening/closing positions — either from the user's own
// margin (direct path) or funded by pool credit (pool-backed path).
//
// Phase 2: a "Paired" toggle on the open buttons funds both legs of a
// pair atomically. Paired LAPs are delta-neutral (positive gamma, no
// directional bet); they unlock as collateral for stablecoin minting in
// Phase 4 and become rentable in Phase 3.
import { useState } from "react";
import { PAIRS } from "../constants/assets.js";
import { HelpHint } from "./Tooltip.jsx";
import { isPairedLap } from "../lib/pairedLap.js";

export function PortfolioStructurer({
  openPositions,
  creditEligibility,
  onOpen,
  onClose,
  poolLtv = null,
  availablePoolCredit = 0,
  poolDepositAmount = 0,
  deployedPoolCredit = 0,
  // pairKey → { activeRentals, rentalOffers }, queried per position to
  // surface lease status + offer queue.
  rentalsByPair = {},
}) {
  const hasPool = poolDepositAmount > 0;
  const [pairedMode, setPairedMode] = useState(false);

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <span className="text-xs font-mono text-gray-300 flex items-center">
        Portfolio Structurer
        <HelpHint
          width={300}
          text="Open LAPs from direct margin (tagged as auction collateral) or funded by pool credit. Pool-funded LAPs are tethered to your deposit: if either side loses, the haircut propagates on a lagged tick. Paired LAPs hold both sides of one pair at once — delta-neutral with positive gamma; cost = 2× a single LAP. Paired LAPs become rentable in Phase 3 and back stablecoin minting in Phase 4."
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
        const paired = isPairedLap(pos);
        const sideOrPaired = paired ? "PAIRED" : pos.side;
        const sideColor = paired
          ? "#a78bfa"
          : pos.side === "LONG"
            ? "#34d399"
            : "#f87171";
        // Rental status for paired LAPs only.
        const rentalsHere = rentalsByPair[pos.pairKey] ?? {};
        const activeForLap = paired
          ? (rentalsHere.activeRentals ?? []).filter(
              (r) => r.pairLapId === pos.id && r.active
            )
          : [];
        const longRented = activeForLap.find((r) => r.legSide === "long");
        const shortRented = activeForLap.find((r) => r.legSide === "short");
        return (
          <div
            key={i}
            className={`flex items-center justify-between gap-2 rounded border px-2 py-1 ${
              paired
                ? "border-purple-800 bg-purple-950/30"
                : isPoolBacked
                  ? "border-indigo-800 bg-indigo-950/40"
                  : "border-gray-800 bg-gray-950"
            }`}
          >
            <div className="flex flex-col min-w-0">
              <div className="flex items-center gap-1 flex-wrap">
                <span className="text-xs font-mono text-gray-200">{pair?.symbol ?? pos.pairKey}</span>
                <span
                  className="text-[10px] font-mono px-1 rounded"
                  style={{ color: sideColor }}
                >
                  {sideOrPaired}
                </span>
                <span className="text-[10px] font-mono text-gray-500">{(pos.leverage ?? 1).toFixed(2)}×</span>
                {paired && (
                  <span className="text-[10px] font-mono px-1 rounded border border-purple-700 bg-purple-950 text-purple-300">
                    Δ-neutral
                  </span>
                )}
                {isPoolBacked && (
                  <span className="text-[10px] font-mono px-1 rounded border border-indigo-700 bg-indigo-950 text-indigo-300">
                    pool
                  </span>
                )}
                {longRented && (
                  <span
                    className="text-[10px] font-mono px-1 rounded border border-emerald-700 bg-emerald-950 text-emerald-300"
                    title={`Long leg leased to ${longRented.renterId} @ ${(longRented.tipRate * 100).toFixed(2)}%/ep`}
                  >
                    L:rent
                  </span>
                )}
                {shortRented && (
                  <span
                    className="text-[10px] font-mono px-1 rounded border border-emerald-700 bg-emerald-950 text-emerald-300"
                    title={`Short leg leased to ${shortRented.renterId} @ ${(shortRented.tipRate * 100).toFixed(2)}%/ep`}
                  >
                    S:rent
                  </span>
                )}
              </div>
              <div className="text-[10px] font-mono text-gray-500">
                ${ (pos.margin ?? 0).toFixed(0) }
                {paired && <span className="text-purple-400 ml-1">(both legs)</span>}
                {elig && !elig.eligible && (
                  <span className="text-red-500 ml-1">({elig.reason})</span>
                )}
                {paired && (longRented || shortRented) && (
                  <span className="text-emerald-400 ml-1">
                    earning ~${(
                      (longRented?.tipRate ?? 0) +
                      (shortRented?.tipRate ?? 0)
                    ) ===  0
                      ? 0
                      : (
                          ((longRented?.tipRate ?? 0) + (shortRented?.tipRate ?? 0)) *
                          ((pos.margin ?? 0) / 2) *
                          (pos.leverage ?? 1)
                        ).toFixed(2)}/ep
                  </span>
                )}
              </div>
            </div>
            <button
              onClick={() => onClose?.(i)}
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-red-800 text-red-400 hover:text-red-200 hover:bg-red-950 transition-colors"
              aria-label={`Close ${pair?.symbol ?? pos.pairKey} ${sideOrPaired}`}
            >
              close
            </button>
          </div>
        );
      })}

      {/* Paired-mode toggle */}
      <label className="flex items-center gap-2 text-[10px] font-mono text-gray-400 cursor-pointer select-none">
        <input
          type="checkbox"
          checked={pairedMode}
          onChange={(e) => setPairedMode(e.target.checked)}
          className="accent-purple-500"
        />
        <span>Paired (both legs · 2× capital · Δ-neutral)</span>
      </label>

      <div className="flex gap-1">
        <button
          onClick={() => onOpen?.({ usePoolCredit: false, paired: pairedMode })}
          className={`flex-1 text-[10px] font-mono px-2 py-1 rounded border transition-colors ${
            pairedMode
              ? "border-purple-700 bg-purple-950 text-purple-200 hover:bg-purple-900"
              : "border-gray-700 bg-gray-800 text-gray-300 hover:text-gray-100 hover:bg-gray-700 hover:border-gray-500"
          }`}
        >
          + Direct {pairedMode ? "PAIRED" : "(own margin)"}
        </button>
        <button
          onClick={() => onOpen?.({ usePoolCredit: true, paired: pairedMode })}
          disabled={!hasPool || availablePoolCredit <= 0}
          className={`flex-1 text-[10px] font-mono px-2 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            pairedMode
              ? "border-purple-700 bg-purple-950 text-purple-200 hover:bg-purple-900"
              : "border-indigo-700 bg-indigo-950 text-indigo-300 hover:text-indigo-100 hover:bg-indigo-900"
          }`}
          title={!hasPool ? "Deposit into the pool first" : availablePoolCredit <= 0 ? "No pool credit available" : ""}
        >
          + Pool credit {pairedMode ? "PAIRED" : `($${availablePoolCredit.toFixed(0)})`}
        </button>
      </div>
    </div>
  );
}
