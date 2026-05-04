// EasyMode — single-screen retail view.
//
// Shows one yield number, one "Convert $ → FLOAT" button, one "Redeem
// FLOAT → $" button, and the four-tier ladder. Hides allocation editor,
// reinsurance buyers, paired-LAP desk, B-book deposit form, classifier
// breakdown — all of those live in advanced mode.
//
// The "Convert $X → FLOAT" button calls the same handleMintFloats in App.jsx
// that advanced mode uses. The protocol-level orchestration is
// identical; this just hides the surface.

import { useState } from "react";
import { TierLadder, evaluateGates, currentTierOf } from "./TierLadder.jsx";
import { TBILL_RATE } from "../constants/system.js";
import { BASE_PREMIUM_RATE } from "../lib/insuranceMarket.js";

// Project a sim-annualised yield from the configured rates. This is
// the headline number the retail user sees. It's a projection from
// constants, not realised performance — use the "since you started"
// chip below for realised yield once equity history exists.
//
// Unit conventions (post-Sprint-4.5):
//   - TBILL_RATE is already ANNUAL (used as TBILL_RATE/365 per tick
//     in the loop).
//   - BASE_PREMIUM_RATE is per medium tick (used directly per tick
//     in settleMarketTick), so we ×365 to annualise.
//
// Layers:
//   Layer 1  T-bill            TBILL_RATE  (annual)
//   Layer 2  Insurance premium BASE_PREMIUM_RATE × 365 × 0.5
//                              (insurer-side share)
//   Layer 3  B-book yield      historic-CFD-margin proxy (0.04 annual)
//   Layer 4  FLOAT mint           optionality; no separate yield stream
//
// The four are added because the same dollar earns each one in
// parallel (the whole point of the protocol). Subtract a small
// drag for stress-loss expectation.
function projectAnnualYield({ atTier }) {
  const tbillAnnual = TBILL_RATE; // already annual
  const insuranceAnnual = BASE_PREMIUM_RATE * 365 * 0.5; // per-tick → annual
  const bbookAnnual = 0.04;
  const stressDrag = 0.005; // empirical placeholder; refine with Monte Carlo

  if (atTier === 1) return Math.max(0, tbillAnnual - stressDrag * 0.25);
  if (atTier === 2) return Math.max(0, tbillAnnual + insuranceAnnual - stressDrag * 0.5);
  if (atTier === 3) {
    return Math.max(0, tbillAnnual + insuranceAnnual - stressDrag);
  }
  // tier 4 — full thread, all four roles compounding on the same $.
  return Math.max(0, tbillAnnual + insuranceAnnual + bbookAnnual - stressDrag);
}

export function EasyMode({
  // Player state
  player,
  freeMarginAmount,
  // FLOAT state
  floatsBalance,
  floatsPrincipal,
  // Insurance / allocation state
  allocStats,
  hasReinsurance,
  // Position state
  hasOpenLap,
  // Equity for "since you started" realised yield
  equityHistory = [],
  // Action handlers
  onConvertToFloats,         // (amount) => void  — wraps handleMintFloats
  onRedeem,              // (amount) => void  — wraps handleRedeem(false)
  onJumpToAdvanced,      // () => void        — toggles easyMode off
}) {
  const [convertAmount, setConvertAmount] = useState("");
  const [redeemAmount, setRedeemAmount] = useState("");

  const totalAllocated = allocStats?.totalStake ?? 0;
  const tier = currentTierOf({
    totalAllocated,
    hasOpenLap,
    floatsPrincipal,
  });

  const gates = evaluateGates({
    allocStats,
    hasReinsurance,
    hasFreeMargin: (freeMarginAmount ?? 0) > 0,
  });

  const projectedYield = projectAnnualYield({ atTier: tier });

  // Realised yield since first equity sample.
  const realised =
    equityHistory.length > 1
      ? (equityHistory[equityHistory.length - 1] - equityHistory[0]) / equityHistory[0]
      : null;

  const convertNum = parseFloat(convertAmount);
  const redeemNum = parseFloat(redeemAmount);
  const canConvert = Number.isFinite(convertNum) && convertNum > 0 && convertNum <= freeMarginAmount + 1e-6;
  const canRedeem = Number.isFinite(redeemNum) && redeemNum > 0 && redeemNum <= floatsBalance + 1e-6;

  return (
    <div className="flex flex-col gap-4">
      {/* ----- Headline yield card ----- */}
      <div className="rounded-lg border border-emerald-800 bg-gradient-to-br from-emerald-950 to-gray-950 p-5">
        <div className="flex items-baseline justify-between">
          <div className="flex flex-col">
            <span className="text-[11px] font-mono text-gray-400 uppercase tracking-wide">
              Today's projected yield · sim-annualised
            </span>
            <span className="text-4xl font-mono font-bold text-emerald-300 mt-1">
              {(projectedYield * 100).toFixed(1)}%
            </span>
            <span className="text-[10px] font-mono text-gray-500 mt-1">
              At tier {tier} of 4 — {tier === 4 ? "all four yields stacked on every $" : "more yield unlocks at higher tiers"}
            </span>
          </div>
          {realised != null && (
            <div className="flex flex-col items-end">
              <span className="text-[10px] font-mono text-gray-500 uppercase">
                since start
              </span>
              <span
                className={`text-lg font-mono ${
                  realised >= 0 ? "text-emerald-300" : "text-rose-300"
                }`}
              >
                {realised >= 0 ? "+" : ""}
                {(realised * 100).toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ----- Two action cards side by side ----- */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Convert to FLOAT */}
        <div className="rounded border border-violet-800 bg-violet-950/30 p-4 flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-mono text-violet-200 font-bold">
              Convert $ → FLOAT
            </span>
            <span className="text-[10px] font-mono text-gray-500">
              free: ${freeMarginAmount?.toFixed(0) ?? "0"}
            </span>
          </div>
          <p className="text-[10px] font-mono text-gray-400 leading-tight">
            Auto-runs all four tiers in the safe configuration: even
            allocation across diversified markets, full reinsurance,
            B-book stake, FLOAT mint. One step.
          </p>
          <div className="flex gap-2 mt-1">
            <input
              type="number"
              min="0"
              step="100"
              placeholder="amount"
              value={convertAmount}
              onChange={(e) => setConvertAmount(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200"
            />
            <button
              onClick={() => {
                if (!canConvert) return;
                onConvertToFloats?.(convertNum);
                setConvertAmount("");
              }}
              disabled={!canConvert}
              className={`px-3 py-1 rounded text-xs font-mono ${
                canConvert
                  ? "bg-violet-700 hover:bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              Convert
            </button>
          </div>
          <div className="flex gap-1 flex-wrap mt-1">
            {[100, 500, 1000].map((v) => (
              <button
                key={v}
                onClick={() => setConvertAmount(String(Math.min(v, freeMarginAmount ?? 0)))}
                className="text-[10px] font-mono text-gray-400 hover:text-violet-200 border border-gray-700 hover:border-violet-700 rounded px-1.5 py-0.5"
              >
                ${v}
              </button>
            ))}
            <button
              onClick={() =>
                setConvertAmount(String(Math.floor(freeMarginAmount ?? 0)))
              }
              className="text-[10px] font-mono text-gray-400 hover:text-violet-200 border border-gray-700 hover:border-violet-700 rounded px-1.5 py-0.5"
            >
              max
            </button>
          </div>
        </div>

        {/* Redeem FLOAT */}
        <div className="rounded border border-amber-800 bg-amber-950/30 p-4 flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-mono text-amber-200 font-bold">
              Redeem FLOAT → $
            </span>
            <span className="text-[10px] font-mono text-gray-500">
              wallet: {floatsBalance?.toFixed(0) ?? "0"} FLOAT
            </span>
          </div>
          <p className="text-[10px] font-mono text-gray-400 leading-tight">
            Queues a standard redemption. The next cycle drains up to
            10% of supply; your thread unwinds layer-by-layer in
            lockstep. Express tier (5% penalty) is in advanced mode.
          </p>
          <div className="flex gap-2 mt-1">
            <input
              type="number"
              min="0"
              step="100"
              placeholder="amount"
              value={redeemAmount}
              onChange={(e) => setRedeemAmount(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs font-mono text-gray-200"
            />
            <button
              onClick={() => {
                if (!canRedeem) return;
                onRedeem?.(redeemNum);
                setRedeemAmount("");
              }}
              disabled={!canRedeem}
              className={`px-3 py-1 rounded text-xs font-mono ${
                canRedeem
                  ? "bg-amber-700 hover:bg-amber-600 text-white"
                  : "bg-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              Redeem
            </button>
          </div>
          <div className="flex gap-1 flex-wrap mt-1">
            <button
              onClick={() =>
                setRedeemAmount(String(Math.floor((floatsBalance ?? 0) / 4)))
              }
              className="text-[10px] font-mono text-gray-400 hover:text-amber-200 border border-gray-700 hover:border-amber-700 rounded px-1.5 py-0.5"
            >
              25%
            </button>
            <button
              onClick={() =>
                setRedeemAmount(String(Math.floor((floatsBalance ?? 0) / 2)))
              }
              className="text-[10px] font-mono text-gray-400 hover:text-amber-200 border border-gray-700 hover:border-amber-700 rounded px-1.5 py-0.5"
            >
              50%
            </button>
            <button
              onClick={() => setRedeemAmount(String(Math.floor(floatsBalance ?? 0)))}
              className="text-[10px] font-mono text-gray-400 hover:text-amber-200 border border-gray-700 hover:border-amber-700 rounded px-1.5 py-0.5"
            >
              all
            </button>
          </div>
        </div>
      </div>

      {/* ----- Capital ladder ----- */}
      <div className="rounded border border-gray-800 bg-gray-950/40 p-4">
        <TierLadder
          currentTier={tier}
          principal={(player?.margin ?? 0)}
          gates={gates}
          onJumpToAdvanced={onJumpToAdvanced}
        />
      </div>

      {/* ----- Footer note ----- */}
      <p className="text-[10px] font-mono text-gray-500 leading-relaxed">
        Easy mode auto-allocates evenly across diversified event markets,
        auto-buys reinsurance to cover the insurer-side exposure, deposits
        principal into the B-book pool as passive underwriter stake, and
        mints FLOAT 1:1 against your dollar. Damage in any layer shrinks all
        four atomically — but the four sources are deliberately
        uncorrelated, so the joint distribution stays positive in the
        vast majority of stress scenarios. Switch to advanced mode to
        configure each layer manually.
      </p>
    </div>
  );
}
