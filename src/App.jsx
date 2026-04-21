import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { ACTIVE_PAIRS } from "./constants/assets.js";
import { initPairState } from "./state/pairState.js";
import { useEpochLoop } from "./hooks/useEpochLoop.js";
import { useToast } from "./hooks/useToast.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { usePersistentState } from "./hooks/usePersistentState.js";
import { assessCreditQualification, calcPairCreditEligibility } from "./lib/credit.js";
import { calcSystemSolvencyBuffer, propagateShock, applyShockToPositions } from "./lib/stress.js";
import { calcYieldRouterSuggestions } from "./lib/yieldRouter.js";
import { getEffectiveCap } from "./lib/esma.js";
import { initStrip } from "./lib/strips.js";
import { createOffer, matchBorrowRequest, cancelOffer } from "./lib/lending.js";
import { cx } from "./lib/math.js";
import { POOL_LOCKUP_EPOCHS } from "./constants/system.js";

import { InstrumentSelector } from "./components/InstrumentSelector.jsx";
import { PriceChart } from "./components/PriceChart.jsx";
import { LeverageCurve } from "./components/LeverageCurve.jsx";
import { PlayerPanel } from "./components/PlayerPanel.jsx";
import { PortfolioStructurer } from "./components/PortfolioStructurer.jsx";
import { CreditDesk } from "./components/CreditDesk.jsx";
import { StressPanel } from "./components/StressPanel.jsx";
import { LogicView } from "./components/LogicView.jsx";
import { MetricsPanel } from "./components/MetricsPanel.jsx";
import { NpcPanel } from "./components/NpcPanel.jsx";
import { ContractDesk } from "./components/ContractDesk.jsx";
import { StripDesk } from "./components/StripDesk.jsx";
import { PoolDesk } from "./components/PoolDesk.jsx";
import { TradeHistory } from "./components/TradeHistory.jsx";
import { SpeedControl } from "./components/SpeedControl.jsx";
import { CorrelationHeatmap } from "./components/CorrelationHeatmap.jsx";
import { RegimeTimeline } from "./components/RegimeTimeline.jsx";
import { LendingDesk } from "./components/LendingDesk.jsx";
import { NotificationHistory } from "./components/NotificationHistory.jsx";
import { Tutorial } from "./components/Tutorial.jsx";
import { FeeFlow } from "./components/FeeFlow.jsx";

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

const TABS = ["Chart", "Auction", "Derivatives", "Lending", "Credit", "Stress", "Markets", "History", "Log"];

export default function App() {
  const [pairStates, setPairStates] = useState(INITIAL_PAIR_STATES);
  const [player, setPlayer, clearPlayer] = usePersistentState("tt.player", INITIAL_PLAYER);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = usePersistentState("tt.speed", 1);
  const [activeTab, setActiveTab] = useState("Chart");
  const [mobileNav, setMobileNav] = useState(null); // 'left' | 'right' | null
  const [shockResults, setShockResults] = useState(null);
  const [openPositions, setOpenPositions, clearPositions] = usePersistentState("tt.positions", []);
  const [initialPositions, setInitialPositions, clearInitialPositions] = usePersistentState(
    "tt.initialPositions",
    []
  );
  const [equityHistory, setEquityHistory, clearEquity] = usePersistentState(
    "tt.equity",
    [INITIAL_PLAYER.margin]
  );
  const [tradeLog, setTradeLog, clearTrades] = usePersistentState("tt.trades", []);

  const { toasts, history, addToast, clearHistory } = useToast();
  const [showTutorial, setShowTutorial] = useState(false);

  const { onPlayerEdit } = useEpochLoop({
    pairStates,
    setPairStates,
    player,
    setPlayer,
    setLogs,
    addToast,
    running,
    speed,
  });

  // Track equity history (one sample per medium epoch — the hook updates player.margin).
  const lastMarginRef = useRef(player.margin);
  useEffect(() => {
    if (!running) return;
    if (player.margin !== lastMarginRef.current) {
      setEquityHistory((prev) => [...prev.slice(-299), player.margin]);
      lastMarginRef.current = player.margin;
    }
  }, [player.margin, running, setEquityHistory]);

  const handlePlayerUpdate = useCallback(
    (patch) => {
      setPlayer((prev) => ({ ...prev, ...patch }));
      onPlayerEdit();
    },
    [onPlayerEdit, setPlayer]
  );

  const activePair = player.activePair ?? ACTIVE_PAIRS[0];
  const activePS = pairStates[activePair];
  const { effectiveCap: cap } = getEffectiveCap(activePair, activePS?.realizedSigma ?? 0.02);

  // Derived auction-side statistics.
  const longMargin = useMemo(
    () =>
      (activePS?.auctionResult?.matched ?? [])
        .filter((m) => m.longId)
        .reduce((s, m) => s + m.margin, 0),
    [activePS]
  );
  const shortMargin = useMemo(
    () =>
      (activePS?.auctionResult?.matched ?? [])
        .filter((m) => m.shortId)
        .reduce((s, m) => s + m.margin, 0),
    [activePS]
  );

  const normWeights = activePS?.auctionResult?.normWeights ?? [];
  const avgEntropyMult =
    normWeights.length > 0
      ? normWeights.reduce((s, w) => s + w, 0) / normWeights.length
      : 1;

  // Credit assessment driven by actual equity history.
  const creditAssessment = useMemo(() => {
    const corrMap = activePS?.correlationMap ?? {};
    const history = equityHistory.map((e) => ({
      users: [{ id: "You", margin: e }],
    }));
    return assessCreditQualification(
      history,
      openPositions,
      corrMap,
      activePair,
      initialPositions
    );
  }, [equityHistory, openPositions, initialPositions, activePair, activePS]);

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

  // Circuit breaker: halt the loop when system solvency collapses.
  const breakerRef = useRef(false);
  useEffect(() => {
    if (running && solvency.solvencyBuffer < 0.05 && !breakerRef.current) {
      breakerRef.current = true;
      setRunning(false);
      addToast("Circuit breaker tripped — solvency < 5%", "error");
    }
    if (solvency.solvencyBuffer >= 0.1) breakerRef.current = false;
  }, [running, solvency, addToast]);

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

  // --- Contract / strip / pool handlers ---
  function handleBuyImbalance({ size, direction, strikeImbalance, premium }) {
    const id = `IMB-${Date.now()}`;
    const cost = size * premium;
    if (cost > player.margin) return;
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return {
        ...prev,
        [activePair]: {
          ...ps,
          imbalanceContracts: [
            ...ps.imbalanceContracts,
            { id, size, direction, strikeImbalance, premium },
          ],
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost }));
    addToast(`Bought imbalance ${direction} for $${cost.toFixed(2)}`, "info");
  }

  function handleBuyEntropy({ size, lockedMult, premium }) {
    const id = `ENT-${Date.now()}`;
    const cost = size * premium;
    if (cost > player.margin) return;
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return {
        ...prev,
        [activePair]: {
          ...ps,
          entropyContracts: [
            ...ps.entropyContracts,
            { id, size, lockedMult, premium },
          ],
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost }));
    addToast(`Locked entropy at ${lockedMult.toFixed(1)}× for $${cost.toFixed(2)}`, "info");
  }

  function handleBuyStrip(params) {
    const strip = initStrip({
      id: `STRIP-${Date.now()}`,
      ...params,
      yieldModel: activePS?.yieldModel,
    });
    const cost = strip.margin * strip.premium;
    if (cost > player.margin) return;
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return { ...prev, [activePair]: { ...ps, strips: [...ps.strips, strip] } };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost }));
    addToast(`Strip issued — cover ${(strip.protectedFraction * 100).toFixed(0)}% for ${strip.epochs} epochs`, "info");
  }

  function handleDeposit(amount) {
    if (amount > player.margin) return;
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      const pool = ps.insurancePool;
      const existing = pool.deposits[player.id] ?? { amount: 0, depositEpoch: ps.epochIndex, lockupRemaining: 0 };
      return {
        ...prev,
        [activePair]: {
          ...ps,
          insurancePool: {
            ...pool,
            deposits: {
              ...pool.deposits,
              [player.id]: {
                amount: existing.amount + amount,
                depositEpoch: ps.epochIndex,
                lockupRemaining: POOL_LOCKUP_EPOCHS,
              },
            },
            totalDeposits: pool.totalDeposits + amount,
          },
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - amount }));
    addToast(`Deposited $${amount} into insurance pool`, "info");
  }

  function handleWithdraw(amount) {
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      const pool = ps.insurancePool;
      const existing = pool.deposits[player.id];
      if (!existing || existing.lockupRemaining > 0 || existing.amount <= 0) return prev;
      const take = Math.min(amount, existing.amount);
      const newDeposits = { ...pool.deposits };
      if (existing.amount - take <= 0.01) delete newDeposits[player.id];
      else newDeposits[player.id] = { ...existing, amount: existing.amount - take };
      return {
        ...prev,
        [activePair]: {
          ...ps,
          insurancePool: {
            ...pool,
            deposits: newDeposits,
            totalDeposits: Math.max(0, pool.totalDeposits - take),
          },
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin + amount }));
    addToast(`Withdrew $${amount} from insurance pool`, "info");
  }

  function handleClosePosition(i) {
    const pos = openPositions[i];
    if (!pos) return;
    const ps = pairStates[pos.pairKey];
    const priceNow = ps?.prices?.slice(-1)[0] ?? 1;
    const priceThen = pos.openPrice ?? priceNow;
    const logRet = Math.log(priceNow / priceThen);
    const direction = pos.side === "LONG" ? 1 : -1;
    const pnl = pos.margin * pos.leverage * (Math.exp(direction * logRet) - 1);

    setOpenPositions((prev) => prev.filter((_, idx) => idx !== i));
    setTradeLog((prev) => [...prev, { ...pos, pnl, closedPrice: priceNow }]);
    setPlayer((p) => ({ ...p, margin: p.margin + pos.margin + pnl }));
    addToast(
      `Closed ${pos.pairKey} ${pos.side}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`,
      pnl >= 0 ? "info" : "warning"
    );
  }

  function handleOpenPosition() {
    const priceNow = activePS?.prices?.slice(-1)[0] ?? 1;
    const size = Math.min(1000, player.margin * 0.2);
    if (size < 100) {
      addToast("Insufficient margin to open position", "warning");
      return;
    }
    const newPos = {
      pairKey: activePair,
      side: player.side,
      leverage: player.leverage,
      margin: size,
      openPrice: priceNow,
    };
    setOpenPositions((prev) => [...prev, newPos]);
    // Snapshot as baseline for drift penalty on the first-ever open.
    setInitialPositions((prev) => (prev.length === 0 ? [newPos] : [...prev, newPos]));
    setPlayer((p) => ({ ...p, margin: p.margin - size }));
    addToast(`Opened ${activePair} ${player.side} x${player.leverage.toFixed(1)}`, "info");
  }

  // --- Lending handlers ---
  function handlePostLendingOffer({ amount, rate, duration }) {
    if (amount > player.margin) return;
    const offer = createOffer(player.id, amount, rate, duration);
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return {
        ...prev,
        [activePair]: {
          ...ps,
          lendingOffers: [...ps.lendingOffers, { ...offer, createdEpoch: ps.epochIndex }],
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - amount }));
    addToast(`Posted offer: $${amount} @ ${(rate * 100).toFixed(3)}%`, "info");
  }

  function handleCancelLendingOffer(offerId) {
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      const offer = ps.lendingOffers.find((o) => o.id === offerId);
      if (!offer || offer.lenderId !== player.id) return prev;
      const refund = offer.remaining;
      if (refund > 0) setPlayer((p) => ({ ...p, margin: p.margin + refund }));
      return {
        ...prev,
        [activePair]: {
          ...ps,
          lendingOffers: cancelOffer(ps.lendingOffers, offerId),
        },
      };
    });
    addToast(`Offer ${offerId} cancelled`, "info");
  }

  function handleBorrow({ amount, maxRate }) {
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      const { borrows, updatedOffers, unfilled } = matchBorrowRequest(
        ps.lendingOffers,
        player.id,
        amount,
        maxRate
      );
      if (borrows.length === 0) {
        addToast("No offers matched — try raising max rate", "warning");
        return prev;
      }
      const filled = amount - unfilled;
      addToast(`Borrowed $${filled.toFixed(0)} across ${borrows.length} offers`, "info");
      return {
        ...prev,
        [activePair]: {
          ...ps,
          lendingOffers: updatedOffers,
          lendingBorrows: [...ps.lendingBorrows, ...borrows],
        },
      };
    });
  }

  function handleResetSession() {
    clearPlayer();
    clearPositions();
    clearInitialPositions();
    clearEquity();
    clearTrades();
    setPairStates(INITIAL_PAIR_STATES);
    setLogs([]);
    setShockResults(null);
    addToast("Session reset", "info");
  }

  function applyRouterSuggestion(s) {
    if (s.action === "OPEN_LONG" || s.action === "OPEN_SHORT") {
      setPlayer((p) => ({
        ...p,
        activePair: s.pairKey,
        side: s.action === "OPEN_LONG" ? "LONG" : "SHORT",
        strategy: s.action === "OPEN_LONG" ? "FIXED_LONG" : "FIXED_SHORT",
      }));
      onPlayerEdit();
      addToast(`Router: switch to ${s.pairKey} ${s.action}`, "info");
    }
  }

  useKeyboardShortcuts({
    Space: () => setRunning((r) => !r),
    "1": () => setActiveTab("Chart"),
    "2": () => setActiveTab("Auction"),
    "3": () => setActiveTab("Derivatives"),
    "4": () => setActiveTab("Lending"),
    "5": () => setActiveTab("Credit"),
    "6": () => setActiveTab("Stress"),
    "7": () => setActiveTab("Markets"),
    "8": () => setActiveTab("History"),
    "9": () => setActiveTab("Log"),
    "+": () => setSpeed((s) => Math.min(5, s * 2)),
    "-": () => setSpeed((s) => Math.max(0.5, s / 2)),
    r: () => handleResetSession(),
  });

  return (
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
      {/* Header */}
      <header className="border-b border-gray-800 px-4 py-2 flex items-center gap-4 flex-wrap">
        <button
          onClick={() => setMobileNav("left")}
          className="md:hidden text-xs font-mono px-2 py-1 rounded border border-gray-700 text-gray-300"
          aria-label="Instruments"
        >
          ☰
        </button>
        <span className="font-syne text-lg text-indigo-400 tracking-tight">Trading Tower</span>
        <span className="text-[10px] font-mono text-gray-600">LAP v2 · ESMA compliant</span>
        {openPositions.length > 0 && (
          <span className="text-[10px] font-mono text-emerald-400 px-2 py-0.5 rounded border border-emerald-900 bg-emerald-950">
            {openPositions.length} open
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          <SpeedControl speed={speed} onSpeed={setSpeed} />
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
          <NotificationHistory history={history} onClear={clearHistory} />
          <button
            onClick={() => setMobileNav("right")}
            className="md:hidden text-xs font-mono px-2 py-1 rounded border border-indigo-700 text-indigo-300"
            aria-label="Your Position"
          >
            pos
          </button>
          <button
            onClick={handleResetSession}
            className="text-xs font-mono px-2 py-1 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
            title="Reset session (R)"
          >
            reset
          </button>
          <span className="text-[10px] font-mono text-gray-600">
            σ={((activePS?.realizedSigma ?? 0.02) * 100).toFixed(2)}%
          </span>
          <span className="text-[9px] font-mono text-gray-700 hidden lg:inline">
            space=run · 1-9=tab · +/-=speed · r=reset
          </span>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: instrument list (desktop) */}
        <aside className="w-48 border-r border-gray-800 p-2 overflow-y-auto hidden md:block">
          <InstrumentSelector
            activePair={activePair}
            onSelect={(pk) => handlePlayerUpdate({ activePair: pk })}
            pairStates={pairStates}
          />
        </aside>

        {/* Mobile drawer: instrument list */}
        {mobileNav === "left" && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileNav(null)}
          >
            <aside
              className="absolute left-0 top-0 h-full w-60 bg-gray-950 border-r border-gray-800 p-2 overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-mono text-gray-300">Instruments</span>
                <button
                  onClick={() => setMobileNav(null)}
                  className="text-xs font-mono text-gray-500"
                >
                  ×
                </button>
              </div>
              <InstrumentSelector
                activePair={activePair}
                onSelect={(pk) => {
                  handlePlayerUpdate({ activePair: pk });
                  setMobileNav(null);
                }}
                pairStates={pairStates}
              />
            </aside>
          </div>
        )}

        {/* Center: main view */}
        <main className="flex-1 flex flex-col overflow-hidden">
          <div className="flex gap-1 px-3 py-1 border-b border-gray-800 flex-wrap">
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
                  events={activePS?.events ?? []}
                  currentEpoch={activePS?.epochIndex ?? 0}
                />
                <MetricsPanel equityHistory={equityHistory} />
                <LeverageCurve
                  longCurve={activePS?.auctionResult?.longCurve ?? []}
                  shortCurve={activePS?.auctionResult?.shortCurve ?? []}
                  cap={cap}
                />
                {routerSuggestions.length > 0 && (
                  <div className="rounded border border-gray-800 bg-gray-900 p-2">
                    <div className="text-[10px] font-mono text-gray-500 mb-1">
                      Yield Router Suggestions (click to apply)
                    </div>
                    <div className="flex flex-col gap-1">
                      {routerSuggestions.slice(0, 4).map((s, i) => (
                        <button
                          key={i}
                          onClick={() => applyRouterSuggestion(s)}
                          className="flex items-center justify-between text-[10px] font-mono rounded px-2 py-1 hover:bg-indigo-950 border border-transparent hover:border-indigo-700 transition-colors text-left"
                        >
                          <span className="text-gray-300">{s.pairKey}</span>
                          <span className="text-indigo-400">{s.action}</span>
                          <span className="text-gray-500 truncate max-w-48">
                            {s.reason}
                          </span>
                        </button>
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
                    <div>
                      Imbalance:{" "}
                      {((activePS?.auctionResult?.imbalanceRatio ?? 0) * 100).toFixed(1)}%
                    </div>
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
                <NpcPanel npcs={activePS?.npcs ?? []} />
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

            {activeTab === "Derivatives" && (
              <>
                <ContractDesk
                  longMargin={longMargin}
                  shortMargin={shortMargin}
                  normWeights={normWeights}
                  avgEntropyMult={avgEntropyMult}
                  playerMargin={player.margin}
                  onBuyImbalance={handleBuyImbalance}
                  onBuyEntropy={handleBuyEntropy}
                  openImbalance={activePS?.imbalanceContracts ?? []}
                  openEntropy={activePS?.entropyContracts ?? []}
                />
                <StripDesk
                  playerMargin={player.margin}
                  leverage={player.leverage}
                  realizedSigma={activePS?.realizedSigma ?? 0.02}
                  returnHistory={activePS?.returnHistory ?? []}
                  onBuyStrip={handleBuyStrip}
                  openStrips={activePS?.strips ?? []}
                />
                <PoolDesk
                  pool={activePS?.insurancePool}
                  playerId={player.id}
                  playerMargin={player.margin}
                  onDeposit={handleDeposit}
                  onWithdraw={handleWithdraw}
                />
              </>
            )}

            {activeTab === "Lending" && (
              <LendingDesk
                playerId={player.id}
                playerMargin={player.margin}
                offers={activePS?.lendingOffers ?? []}
                borrows={activePS?.lendingBorrows ?? []}
                yieldBuffer={activePS?.yieldBuffer ?? 0}
                onPostOffer={handlePostLendingOffer}
                onCancelOffer={handleCancelLendingOffer}
                onBorrow={handleBorrow}
              />
            )}

            {activeTab === "Credit" && (
              <>
                <CreditDesk assessment={creditAssessment} />
                <PortfolioStructurer
                  openPositions={openPositions}
                  creditEligibility={creditEligibility}
                  onOpen={handleOpenPosition}
                  onClose={handleClosePosition}
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

            {activeTab === "Markets" && (
              <>
                <RegimeTimeline
                  history={activePS?.regimeHistory ?? []}
                  currentRegime={activePS?.regime}
                  currentEpoch={activePS?.epochIndex ?? 0}
                />
                <FeeFlow ledger={activePS?.feeLedger} />
                <CorrelationHeatmap
                  corrMap={activePS?.correlationMap ?? {}}
                  pairs={ACTIVE_PAIRS}
                />
              </>
            )}

            {activeTab === "History" && <TradeHistory trades={tradeLog} />}

            {activeTab === "Log" && (
              <div
                className="rounded border border-gray-800 bg-gray-900 flex-1"
                style={{ minHeight: "400px" }}
              >
                <LogicView logs={logs} />
              </div>
            )}
          </div>
        </main>

        {/* Right: player panel (desktop) */}
        <aside className="w-56 border-l border-gray-800 p-2 flex flex-col gap-2 overflow-y-auto hidden md:flex">
          <PlayerPanel
            player={player}
            onUpdate={handlePlayerUpdate}
            activePair={activePair}
            cap={cap}
            creditScore={creditAssessment.creditScore}
            creditExtension={creditAssessment.leverageExtension}
          />
        </aside>

        {/* Mobile drawer: player panel */}
        {mobileNav === "right" && (
          <div
            className="fixed inset-0 z-40 bg-black/60 md:hidden"
            onClick={() => setMobileNav(null)}
          >
            <aside
              className="absolute right-0 top-0 h-full w-72 bg-gray-950 border-l border-gray-800 p-2 overflow-y-auto flex flex-col gap-2"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-mono text-gray-300">Position</span>
                <button
                  onClick={() => setMobileNav(null)}
                  className="text-xs font-mono text-gray-500"
                >
                  ×
                </button>
              </div>
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
        )}
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

      {/* Tutorial overlay (first run + manually reopened) */}
      <Tutorial force={showTutorial} onClose={() => setShowTutorial(false)} />

      {/* Re-open tutorial button (bottom-left) */}
      <button
        onClick={() => setShowTutorial(true)}
        className="fixed bottom-4 left-4 z-40 text-[10px] font-mono px-2 py-1 rounded-full border border-gray-700 bg-gray-900 text-gray-400 hover:text-gray-200 hover:border-indigo-500 transition-colors"
        aria-label="Open tutorial"
      >
        ? tutorial
      </button>
    </div>
  );
}
