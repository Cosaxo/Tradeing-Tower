import { useState, useCallback, useMemo } from "react";
import { ACTIVE_PAIRS } from "./constants/assets.js";
import { initPairState } from "./state/pairState.js";
import { useEpochLoop } from "./hooks/useEpochLoop.js";
import { useToast } from "./hooks/useToast.js";
import { assessCreditQualification, calcPairCreditEligibility } from "./lib/credit.js";
import { calcSystemSolvencyBuffer, propagateShock, applyShockToPositions } from "./lib/stress.js";
import { calcYieldRouterSuggestions } from "./lib/yieldRouter.js";
import { getEffectiveCap } from "./lib/esma.js";
import { cx } from "./lib/math.js";

import { InstrumentSelector } from "./components/InstrumentSelector.jsx";
import { PriceChart } from "./components/PriceChart.jsx";
import { LeverageCurve } from "./components/LeverageCurve.jsx";
import { PlayerPanel } from "./components/PlayerPanel.jsx";
import { PortfolioStructurer } from "./components/PortfolioStructurer.jsx";
import { CreditDesk } from "./components/CreditDesk.jsx";
import { StressPanel } from "./components/StressPanel.jsx";
import { LogicView } from "./components/LogicView.jsx";

// Initialise all pair states at module load — deterministic.
const INITIAL_PAIR_STATES = Object.fromEntries(
  ACTIVE_PAIRS.map((pk) => [pk, initPairState(pk)])
);

const INITIAL_PLAYER = {
  id: "You",
  activePair: ACTIVE_PAIRS[0],
  leverage: 2.0,
  margin: 5000,
  side: "LONG",
  strategy: "FIXED_LONG",
  minYield: 0.0,
  tip_tiers: [{ lev_start: 1.0, lev_end: 2.0, tip: 0.02, fill_direction: "bottom-up" }],
  pnl: 0,
  liquidated: false,
};

const TABS = ["Chart", "Auction", "Credit", "Stress", "Log"];

export default function App() {
  const [pairStates, setPairStates] = useState(INITIAL_PAIR_STATES);
  const [player, setPlayer] = useState(INITIAL_PLAYER);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [activeTab, setActiveTab] = useState("Chart");
  const [shockResults, setShockResults] = useState(null);
  const [openPositions, setOpenPositions] = useState([]);

  const { toasts, addToast } = useToast();

  const { onPlayerEdit } = useEpochLoop({
    pairStates,
    setPairStates,
    player,
    setPlayer,
    setLogs,
    addToast,
    running,
  });

  const handlePlayerUpdate = useCallback(
    (patch) => {
      setPlayer((prev) => ({ ...prev, ...patch }));
      onPlayerEdit();
    },
    [onPlayerEdit]
  );

  const activePair = player.activePair ?? ACTIVE_PAIRS[0];
  const activePS = pairStates[activePair];
  const { effectiveCap: cap } = getEffectiveCap(activePair, activePS?.realizedSigma ?? 0.02);

  // Credit assessment (slow — computed from state, no intervals needed here).
  const creditAssessment = useMemo(() => {
    const corrMap = activePS?.correlationMap ?? {};
    return assessCreditQualification(
      Object.values(pairStates).flatMap((ps) => ps?.prices?.map((p) => ({ users: [{ id: "You", margin: p }] })) ?? []),
      openPositions,
      corrMap,
      activePair
    );
  }, [pairStates, openPositions, activePair, activePS]);

  const creditEligibility = useMemo(() => {
    const corrMap = activePS?.correlationMap ?? {};
    return Object.fromEntries(
      ACTIVE_PAIRS.map((pk) => [
        pk,
        calcPairCreditEligibility(pk, creditAssessment.creditScore, openPositions, corrMap),
      ])
    );
  }, [creditAssessment, openPositions, activePS]);

  const solvency = useMemo(
    () => calcSystemSolvencyBuffer(pairStates, activePS?.insurancePool?.totalDeposits ?? 0),
    [pairStates, activePS]
  );

  const routerSuggestions = useMemo(() => {
    const states = Object.fromEntries(
      ACTIVE_PAIRS.map((pk) => {
        const ps = pairStates[pk];
        return [
          pk,
          {
            normWeights: ps?.auctionResult?.normWeights ?? [],
            avgEntropyMult:
              (ps?.auctionResult?.normWeights ?? []).reduce((s, w) => s + w, 0) /
              Math.max(1, (ps?.auctionResult?.normWeights ?? []).length),
            regime: ps?.regime,
            realizedSigma: ps?.realizedSigma ?? 0.02,
            currentYield: ps?.currentYield ?? 0,
          },
        ];
      })
    );
    return calcYieldRouterSuggestions(states, openPositions, creditAssessment.creditScore);
  }, [pairStates, openPositions, creditAssessment]);

  function handleRunShock() {
    const corrMap = activePS?.correlationMap ?? {};
    const prices = Object.fromEntries(
      ACTIVE_PAIRS.map((pk) => [pk, pairStates[pk]?.prices?.slice(-1)[0] ?? 1])
    );
    const impact = propagateShock(activePair, -0.2, corrMap, ACTIVE_PAIRS);
    const allPositions = [
      ...openPositions,
      { pairKey: activePair, side: player.side, leverage: player.leverage, margin: player.margin },
    ];
    const result = applyShockToPositions(allPositions, impact, prices, activePS?.realizedSigma ?? 0.02);
    setShockResults(result);
    addToast(`Shock: ${result.liquidated} liq, $${result.systemLoss?.toFixed(0)} loss`, "warning");
  }

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-4 py-2 flex items-center gap-4">
        <span className="font-syne text-lg text-indigo-400 tracking-tight">Trading Tower</span>
        <span className="text-[10px] font-mono text-gray-600">LAP v2 · ESMA compliant</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setRunning((r) => !r)}
            className={cx(
              "text-xs font-mono px-3 py-1 rounded border transition-colors",
              running
                ? "border-red-700 bg-red-950 text-red-300 hover:bg-red-900"
                : "border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900"
            )}
          >
            {running ? "PAUSE" : "START"}
          </button>
          <span className="text-[10px] font-mono text-gray-600">
            σ={((activePS?.realizedSigma ?? 0.02) * 100).toFixed(2)}%
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: instrument list */}
        <aside className="w-48 border-r border-gray-800 p-2 overflow-y-auto hidden md:block">
          <InstrumentSelector
            activePair={activePair}
            onSelect={(pk) => handlePlayerUpdate({ activePair: pk })}
            pairStates={pairStates}
          />
        </aside>

        {/* Center: main view */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Tab bar */}
          <div className="flex gap-1 px-3 py-1 border-b border-gray-800">
            {TABS.map((t) => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={cx(
                  "text-xs font-mono px-3 py-1 rounded transition-colors",
                  activeTab === t
                    ? "bg-indigo-900 text-indigo-200"
                    : "text-gray-500 hover:text-gray-300"
                )}
              >
                {t}
              </button>
            ))}
          </div>

          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {activeTab === "Chart" && (
              <>
                <PriceChart
                  prices={activePS?.prices ?? []}
                  regime={activePS?.regime}
                  width={600}
                  pair={activePS?.pair}
                />
                <LeverageCurve
                  longCurve={activePS?.auctionResult?.longCurve ?? []}
                  shortCurve={activePS?.auctionResult?.shortCurve ?? []}
                  cap={cap}
                />
                {routerSuggestions.length > 0 && (
                  <div className="rounded border border-gray-800 bg-gray-900 p-2">
                    <div className="text-[10px] font-mono text-gray-500 mb-1">Yield Router Suggestions</div>
                    <div className="flex flex-col gap-1">
                      {routerSuggestions.slice(0, 3).map((s, i) => (
                        <div key={i} className="flex items-center justify-between text-[10px] font-mono">
                          <span className="text-gray-300">{s.pairKey}</span>
                          <span className="text-indigo-400">{s.action}</span>
                          <span className="text-gray-500 truncate max-w-48">{s.reason}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {activeTab === "Auction" && (
              <div className="flex flex-col gap-2 font-mono text-xs">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border border-gray-800 bg-gray-900 p-2">
                    <div className="text-[10px] text-gray-500 mb-1">Auction Stats</div>
                    <div>Matches: {activePS?.auctionResult?.totalMatched ?? 0}</div>
                    <div>Avg Lev: {(activePS?.auctionResult?.avgLev ?? 0).toFixed(2)}×</div>
                    <div>Imbalance: {((activePS?.auctionResult?.imbalanceRatio ?? 0) * 100).toFixed(1)}%</div>
                    <div>Soft Close: {activePS?.auctionResult?.softClose ? "YES" : "no"}</div>
                    <div>Alpha: {(activePS?.alpha ?? 0.5).toFixed(3)}</div>
                  </div>
                  <div className="rounded border border-gray-800 bg-gray-900 p-2">
                    <div className="text-[10px] text-gray-500 mb-1">Insurance Pool</div>
                    <div>Deposits: ${(activePS?.insurancePool?.totalDeposits ?? 0).toFixed(0)}</div>
                    <div>Yield: {(activePS?.insurancePool?.lastYieldPct ?? 0).toFixed(4)}%</div>
                    <div>Mult: {(activePS?.insurancePool?.yieldMultiplier ?? 1).toFixed(2)}×</div>
                    <div>Depth: {(activePS?.insurancePool?.auctionDepthScore ?? 0).toFixed(3)}</div>
                  </div>
                </div>
                <LeverageCurve
                  longCurve={activePS?.auctionResult?.longCurve ?? []}
                  shortCurve={activePS?.auctionResult?.shortCurve ?? []}
                  cap={cap}
                />
                <div className="rounded border border-gray-800 bg-gray-900 p-2">
                  <div className="text-[10px] text-gray-500 mb-1">Recent Matches</div>
                  {(activePS?.auctionResult?.matched ?? []).slice(0, 8).map((m, i) => (
                    <div key={i} className="flex gap-3 text-[10px]">
                      <span className="text-emerald-400">{m.longId}</span>
                      <span className="text-gray-600">↔</span>
                      <span className="text-red-400">{m.shortId}</span>
                      <span className="text-gray-400">{m.leverage.toFixed(2)}×</span>
                      <span className="text-indigo-400">${m.margin}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeTab === "Credit" && (
              <>
                <CreditDesk assessment={creditAssessment} />
                <PortfolioStructurer
                  openPositions={openPositions}
                  creditEligibility={creditEligibility}
                  onOpen={() =>
                    setOpenPositions((prev) => [
                      ...prev,
                      { pairKey: activePair, side: player.side, leverage: player.leverage, margin: player.margin },
                    ])
                  }
                  onClose={(i) =>
                    setOpenPositions((prev) => prev.filter((_, idx) => idx !== i))
                  }
                />
              </>
            )}

            {activeTab === "Stress" && (
              <StressPanel
                solvency={solvency}
                shockResults={shockResults}
                onRunShock={handleRunShock}
              />
            )}

            {activeTab === "Log" && (
              <div className="rounded border border-gray-800 bg-gray-900 flex-1" style={{ minHeight: "400px" }}>
                <LogicView logs={logs} />
              </div>
            )}
          </div>
        </main>

        {/* Right: player panel */}
        <aside className="w-56 border-l border-gray-800 p-2 flex flex-col gap-2 overflow-y-auto">
          <PlayerPanel
            player={player}
            onUpdate={handlePlayerUpdate}
            activePair={activePair}
            cap={cap}
            creditScore={creditAssessment.creditScore}
            creditExtension={creditAssessment.leverageExtension}
          />
        </aside>
      </div>

      {/* Toasts */}
      <div className="fixed bottom-4 right-4 flex flex-col gap-1 z-50">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              "text-xs font-mono px-3 py-2 rounded border shadow-lg",
              t.type === "error"
                ? "border-red-700 bg-red-950 text-red-200"
                : t.type === "warning"
                ? "border-yellow-700 bg-yellow-950 text-yellow-200"
                : "border-indigo-700 bg-indigo-950 text-indigo-200"
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </div>
  );
}
