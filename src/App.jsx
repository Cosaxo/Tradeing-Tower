import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { ACTIVE_PAIRS } from "./constants/assets.js";
import { initPairState } from "./state/pairState.js";
import { initInsuranceState } from "./state/insuranceState.js";
import { useEpochLoop } from "./hooks/useEpochLoop.js";
import { useToast } from "./hooks/useToast.js";
import { useKeyboardShortcuts } from "./hooks/useKeyboardShortcuts.js";
import { usePersistentState } from "./hooks/usePersistentState.js";
import { calcPairCreditEligibility } from "./lib/credit.js";
import { calcSystemSolvencyBuffer, propagateShock, applyShockToPositions } from "./lib/stress.js";
import { calcYieldRouterSuggestions } from "./lib/yieldRouter.js";
import { calcAllocationLtv, calcAvailableCredit } from "./lib/ltv.js";
import {
  setUserAllocation,
  applyAllocations,
  allocationDiversificationStats,
  propagateLapPnl,
} from "./lib/allocations.js";
import { postInsurer, withdrawInsurer } from "./lib/insuranceMarket.js";
import { postReinsuranceBuyer } from "./lib/reinsurance.js";
import { makePairedLap, isPairedLap, calcPairedLapClosePnl } from "./lib/pairedLap.js";
import { publishLegOffer, terminateRental } from "./lib/rentalMarket.js";
import {
  initTtState,
  openThread,
  calcInsuranceFillWeights,
  transferTT,
  submitRedemption,
  cancelRedemption,
  totalThreadPrincipal,
} from "./lib/towerTether.js";
import {
  initBBookState,
  depositUnderwriter,
  withdrawUnderwriter,
  adjustThreadDerived,
  openContract as openBBookContract,
  closeContract as closeBBookContract,
} from "./lib/bBookPool.js";
import {
  initClassifierState,
  recordClose as recordClassifierClose,
  getUserStats as getClassifierStats,
  routeFor,
} from "./lib/userClassifier.js";
import {
  damageThread,
  growThread,
} from "./lib/towerTether.js";
import { getEffectiveCap } from "./lib/esma.js";
import { initLedger } from "./lib/roleLedger.js";
import { initTags, tryTag, untag, freeMargin } from "./lib/capitalTags.js";
import { cx } from "./lib/math.js";

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
import { TtDesk } from "./components/TtDesk.jsx";
import { InsuranceDesk } from "./components/InsuranceDesk.jsx";
import { BBookDesk } from "./components/BBookDesk.jsx";
import { LapPayoffCurve } from "./components/LapPayoffCurve.jsx";
import { GettingStarted } from "./components/GettingStarted.jsx";
import { TradeHistory } from "./components/TradeHistory.jsx";
import { SpeedControl } from "./components/SpeedControl.jsx";
import { CorrelationHeatmap } from "./components/CorrelationHeatmap.jsx";
import { RegimeTimeline } from "./components/RegimeTimeline.jsx";
import { NotificationHistory } from "./components/NotificationHistory.jsx";
import { Tutorial } from "./components/Tutorial.jsx";
import { FeeFlow } from "./components/FeeFlow.jsx";
import { RoleLedger } from "./components/RoleLedger.jsx";

// Generate a stable id for pool-funded LAPs so position close routes
// the linkage record correctly. (The pre-Phase-5 makeLapId helper lived
// in poolLinkage.js, which has been deleted.)
let _lapCtr = 0;
function makeLapId() {
  return `LAP-${Date.now().toString(36)}-${(++_lapCtr).toString(36)}`;
}

const INITIAL_PAIR_STATES = Object.fromEntries(
  ACTIVE_PAIRS.map((pk) => [pk, initPairState(pk)])
);

// Small at-a-glance chip used in the header summary line. Clickable
// when an `onClick` is supplied; otherwise it's just a static label.
function HeaderChip({ label, value, color, title, onClick }) {
  const cls = `text-[10px] font-mono px-2 py-0.5 rounded border ${color} ${onClick ? "cursor-pointer hover:brightness-110" : ""}`;
  return (
    <span
      className={cls}
      title={title}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={onClick ? (e) => (e.key === "Enter" || e.key === " ") && onClick() : undefined}
    >
      <span className="text-gray-500 mr-1">{label}</span>
      {value}
    </span>
  );
}

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
  tags: initTags(), // §10.1 — capital accumulates roles via tags, not transfers
};

const TABS = ["Chart", "Auction", "Insurance", "Credit", "B-book", "Stress", "Markets", "History", "Log"];

export default function App() {
  // pairStates is persisted so epoch counters, price history, and
  // regime context survive a reload. Without this, openPositions
  // would carry an `openedAtEpoch` that referred to a counter that
  // had been reset to 0 — making the field meaningless.
  const [pairStates, setPairStates, clearPairStates] = usePersistentState(
    "tt.pairStates",
    INITIAL_PAIR_STATES
  );
  const [player, setPlayer, clearPlayer] = usePersistentState("tt.player", INITIAL_PLAYER);
  const [logs, setLogs] = useState([]);
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = usePersistentState("tt.speed", 1);
  const [activeTab, setActiveTab] = useState("Chart");
  const [mobileNav, setMobileNav] = useState(null); // 'left' | 'right' | null
  const [shockResults, setShockResults] = useState(null);
  const [openPositions, setOpenPositions, clearPositions] = usePersistentState("tt.positions", []);
  const [equityHistory, setEquityHistory, clearEquity] = usePersistentState(
    "tt.equity",
    [INITIAL_PLAYER.margin]
  );
  const [tradeLog, setTradeLog, clearTrades] = usePersistentState("tt.trades", []);
  const [roleLedger, setRoleLedger, clearLedger] = usePersistentState(
    "tt.roleLedger",
    initLedger()
  );
  const [ttState, setTtState, clearTt] = usePersistentState(
    "tt.towerTether",
    initTtState()
  );
  const [insuranceState, setInsuranceState, clearInsurance] = usePersistentState(
    "tt.insurance",
    initInsuranceState()
  );
  const [bBookState, setBBookState, clearBBook] = usePersistentState(
    "tt.bBook",
    initBBookState()
  );
  const [classifierState, setClassifierState, clearClassifier] = usePersistentState(
    "tt.classifier",
    initClassifierState()
  );
  const { toasts, history, addToast, clearHistory } = useToast();
  const [showTutorial, setShowTutorial] = useState(false);

  const { onPlayerEdit } = useEpochLoop({
    pairStates,
    setPairStates,
    player,
    setPlayer,
    openPositions,
    setOpenPositions,
    ttState,
    setTtState,
    insuranceState,
    setInsuranceState,
    bBookState,
    setBBookState,
    setLogs,
    addToast,
    running,
    speed,
    setRoleLedger,
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

  // Allocation diversification stats — the new replacement for the
  // pre-Phase-5 "pool deposit" derivation. The user's collateral lives
  // distributed across the insurance markets they've allocated into.
  const allocStats = useMemo(
    () => allocationDiversificationStats({ markets: insuranceState.markets, userId: player.id }),
    [insuranceState.markets, player.id]
  );
  // "Pool deposit amount" in the legacy sense → total stake the player
  // has placed across all insurance markets.
  const poolDepositAmount = allocStats.totalStake;

  // Deployed credit — sum of creditConsumed across pool-linked LAPs.
  const deployedPoolCredit = useMemo(() => {
    return openPositions.reduce(
      (sum, pos) =>
        pos?.poolLinkage && pos.poolLinkage.depositorId === player.id
          ? sum + (pos.poolLinkage.creditConsumed ?? 0)
          : sum,
      0
    );
  }, [openPositions, player.id]);

  const poolLtvInfo = useMemo(
    () => calcAllocationLtv({ markets: insuranceState.markets, userId: player.id }),
    [insuranceState.markets, player.id]
  );
  const availablePoolCredit = useMemo(
    () =>
      calcAvailableCredit({
        markets: insuranceState.markets,
        userId: player.id,
        deployedCredit: deployedPoolCredit,
      }),
    [insuranceState.markets, player.id, deployedPoolCredit]
  );

  // pairKey → { activeRentals, rentalOffers } slice for the rental UI.
  const rentalsByPair = useMemo(() => {
    const out = {};
    for (const pk of ACTIVE_PAIRS) {
      const ps = pairStates[pk];
      if (!ps) continue;
      out[pk] = {
        activeRentals: ps.activeRentals ?? [],
        rentalOffers: ps.rentalOffers ?? [],
      };
    }
    return out;
  }, [pairStates]);

  // Pool LTV is the only credit signal now (legacy credit assessment cut).
  // Eligibility remains a per-pair structural check: don't open a third
  // position on a pair that already holds long+short.
  const creditEligibility = useMemo(
    () =>
      Object.fromEntries(
        ACTIVE_PAIRS.map((pk) => [pk, calcPairCreditEligibility(pk, openPositions)])
      ),
    [openPositions]
  );

  const solvency = useMemo(
    // Old per-pair `insurancePool.totalDeposits` is gone; pass 0 as the
    // fallback insurance pool buffer since solvency is now driven by
    // open-position margin coverage alone.
    () => calcSystemSolvencyBuffer(pairStates, 0),
    [pairStates]
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
    // Yield router uses LTV as the "how confident is this trader" boost,
    // replacing the old legacy creditScore.
    return calcYieldRouterSuggestions(states, openPositions, poolLtvInfo?.ltv ?? 0);
  }, [pairStates, openPositions, poolLtvInfo]);

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

  // --- Allocation handler (§10.1 same-capital semantics) ---
  //
  // The user declares a percentage allocation across insurance markets.
  // The backing capital is then materialised as insurer-side stakes on
  // the corresponding markets. Margin is untouched — these stakes serve
  // the insurer role while the same dollars also back LAP credit and TT
  // mints (multi-role capital).
  function handleSetAllocation(marketAllocations) {
    const r = setUserAllocation(insuranceState.allocations, player.id, marketAllocations);
    if (!r.ok) {
      addToast(`Allocation failed: ${r.reason}`, "warning");
      return;
    }
    const totalCapital = Math.max(0, freeMargin(player.margin, player.tags));
    const applied = applyAllocations({
      markets: insuranceState.markets,
      userId: player.id,
      userAllocation: r.allocations.byUser[player.id],
      totalCapital,
    });
    setInsuranceState({
      ...insuranceState,
      allocations: r.allocations,
      markets: applied.markets,
    });
    addToast("Allocation updated", "info");
  }

  function handleClosePosition(i) {
    const pos = openPositions[i];
    if (!pos) return;
    const ps = pairStates[pos.pairKey];
    const priceNow = ps?.prices?.slice(-1)[0] ?? 1;
    const priceThen = pos.openPrice ?? priceNow;

    // B-book contract: settles through the pool, not the auction. The
    // user takes their P&L from the pool's stake (or pays into it on
    // a loss). Underwriters share P&L pro-rata.
    if (pos.type === "bbook" && pos.bBookContractId) {
      const closed = closeBBookContract({
        state: bBookState,
        contractId: pos.bBookContractId,
        currentPrice: priceNow,
      });
      if (!closed.ok) {
        addToast(`B-book close failed: ${closed.reason}`, "warning");
        return;
      }

      // closeBBookContract has already updated threadDerivedStake
      // proportionally per underwriter. Now propagate the same
      // thread-derived deltas into each thread's principal + the other
      // layers so the 4-layer invariant holds (pool moved → T-bill +
      // insurance + ttFace move too). poolLayerDelta/Add from
      // damage/growThread is informational here — the pool was already
      // moved by closeContract.
      let workingTt = closed.state ? ttState : ttState; // closed.state is bBookState
      let workingInsurance = insuranceState;
      for (const [uid, shares] of Object.entries(closed.underwriterShares ?? {})) {
        const td = shares?.threadDerived ?? 0;
        if (Math.abs(td) <= 1e-9) continue;
        const userThreads = (workingTt.threads ?? []).filter(
          (t) => !t.closed && t.ownerId === uid && t.principal > 1e-9
        );
        if (userThreads.length === 0) continue;
        const totalPrincipal = userThreads.reduce((s, t) => s + t.principal, 0);
        if (totalPrincipal <= 0) continue;
        for (const t of userThreads) {
          const portion = td * (t.principal / totalPrincipal);
          if (Math.abs(portion) <= 1e-9) continue;
          if (portion > 0) {
            const grown = growThread({
              ttState: workingTt,
              threadId: t.id,
              gain: portion,
            });
            workingTt = grown.ttState;
            for (const [eventId, add] of Object.entries(grown.insuranceLayerAdds)) {
              if (add <= 1e-9) continue;
              workingInsurance = {
                ...workingInsurance,
                markets: workingInsurance.markets.map((m) => {
                  if (m.eventId !== eventId) return m;
                  const pr = postInsurer({ market: m, userId: uid, amount: add });
                  return pr.ok ? pr.market : m;
                }),
              };
            }
          } else {
            const dmg = damageThread({
              ttState: workingTt,
              threadId: t.id,
              delta: -portion,
            });
            workingTt = dmg.ttState;
            for (const [eventId, cut] of Object.entries(dmg.insuranceLayerDeltas)) {
              if (cut <= 1e-9) continue;
              workingInsurance = {
                ...workingInsurance,
                markets: workingInsurance.markets.map((m) => {
                  if (m.eventId !== eventId) return m;
                  const wr = withdrawInsurer({ market: m, userId: uid, amount: cut });
                  return wr.ok ? wr.market : m;
                }),
              };
            }
          }
        }
      }

      setBBookState(closed.state);
      setTtState(workingTt);
      if (workingInsurance !== insuranceState) {
        setInsuranceState(workingInsurance);
      }
      setOpenPositions((prev) => prev.filter((_, idx) => idx !== i));
      setTradeLog((prev) => [
        ...prev,
        { ...pos, pnl: closed.userPnl, closedPrice: priceNow },
      ]);
      setPlayer((p) => ({
        ...p,
        margin: p.margin + closed.userPnl,
        tags: untag(p.tags ?? {}, "auctionMargin", pos.margin),
      }));
      setClassifierState((prev) =>
        recordClassifierClose(prev, player.id, {
          pnl: closed.userPnl,
          marginAtOpen: pos.margin,
          closedAtEpoch: ps?.epochIndex ?? 0,
        })
      );
      addToast(
        `Closed ${pos.pairKey} ${pos.side} (B-book): ${closed.userPnl >= 0 ? "+" : ""}$${closed.userPnl.toFixed(2)}`,
        closed.userPnl >= 0 ? "info" : "warning"
      );
      return;
    }

    // Two close formulas. Single LAPs use the directional log-return
    // formula; paired LAPs decompose into long + short legs that
    // largely cancel, leaving positive gamma. Both close atomically —
    // a paired LAP can't be half-closed in Phase 2.
    let pnl;
    if (isPairedLap(pos)) {
      const { netPnl } = calcPairedLapClosePnl(pos, priceNow);
      pnl = netPnl;
    } else {
      const logRet = Math.log(priceNow / priceThen);
      const direction = pos.side === "LONG" ? 1 : -1;
      pnl = pos.margin * pos.leverage * (Math.exp(direction * logRet) - 1);
    }

    // Pool-linked LAP (loose allocation, not a thread): gains grow
    // stakes pro-rata, losses shrink them. Thread-linked closes are
    // blocked above — they must unwind via TT redemption to preserve
    // the 4-layer invariant.
    if (pos.poolLinkage && pos.poolLinkage.depositorId === player.id) {
      const r = propagateLapPnl({
        markets: insuranceState.markets,
        userId: player.id,
        lapPnl: pnl,
      });
      setInsuranceState({ ...insuranceState, markets: r.markets });
    }

    // Paired LAP close: terminate any active rentals on its legs and
    // drop unmatched offers. Renters get any unspent rental margin
    // back (added to the owner's accruedOwnerTips for clarity in the
    // log; refunds to NPC margin happen via the loop on next tick).
    if (isPairedLap(pos)) {
      let ownerCreditFromTermination = 0;
      setPairStates((prev) => {
        const target = prev[pos.pairKey];
        if (!target) return prev;
        const stillActive = [];
        for (const r of target.activeRentals ?? []) {
          if (r.pairLapId === pos.id && r.active) {
            const result = terminateRental(r);
            if (result) ownerCreditFromTermination += result.finalOwnerCredit;
          } else {
            stillActive.push(r);
          }
        }
        const remainingOffers = (target.rentalOffers ?? []).filter(
          (o) => o.pairLapId !== pos.id
        );
        return {
          ...prev,
          [pos.pairKey]: {
            ...target,
            activeRentals: stillActive,
            rentalOffers: remainingOffers,
          },
        };
      });
      if (ownerCreditFromTermination > 0) {
        setPlayer((p) => ({
          ...p,
          margin: (p.margin ?? 0) + ownerCreditFromTermination,
        }));
      }
    }

    setOpenPositions((prev) => prev.filter((_, idx) => idx !== i));
    setTradeLog((prev) => [...prev, { ...pos, pnl, closedPrice: priceNow }]);
    // P&L is a real cash flow; auction-margin tag is released. Paired
    // LAPs untag the FULL `pos.margin` (both legs were tagged together
    // at open time).
    setPlayer((p) => ({
      ...p,
      margin: p.margin + pnl,
      tags: untag(p.tags, "auctionMargin", pos.margin),
    }));
    // Classifier records this close — affects future A/B routing.
    setClassifierState((prev) =>
      recordClassifierClose(prev, player.id, {
        pnl,
        marginAtOpen: pos.margin,
        closedAtEpoch: ps?.epochIndex ?? 0,
      })
    );
    const desc = isPairedLap(pos)
      ? `${pos.pairKey} PAIRED`
      : `${pos.pairKey} ${pos.side}`;
    addToast(
      `Closed ${desc}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}${pos.poolLinkage ? " (pool-linked)" : ""}`,
      pnl >= 0 ? "info" : "warning"
    );
  }

  function handleOpenPosition(opts = {}) {
    const { usePoolCredit = false, paired = false } = opts;
    const priceNow = activePS?.prices?.slice(-1)[0] ?? 1;

    // For paired LAPs, the user funds BOTH legs — `requiredCapital` is
    // 2× the displayed size. We size the long-leg at the same default
    // as a single LAP, so a paired LAP costs twice as much capital.
    const legSize = Math.min(1000, freeMargin(player.margin, player.tags) * 0.2);
    if (legSize < 100) {
      addToast("Not enough free margin to open position", "warning");
      return;
    }
    const requiredCapital = paired ? legSize * 2 : legSize;

    // Pool-credit path: verify headroom for the FULL required capital
    // (both legs if paired). One pool linkage covers the whole paired
    // LAP — both legs share a single linkage id. The linkage tag now
    // identifies the position only; the actual collateral lookup runs
    // through allocations on close (see handleClosePosition).
    let poolLinkage = null;
    if (usePoolCredit) {
      if (availablePoolCredit < requiredCapital) {
        addToast(
          `Not enough pool credit: $${availablePoolCredit.toFixed(0)} available, need $${requiredCapital.toFixed(0)}${paired ? " (paired = 2 legs)" : ""}`,
          "warning"
        );
        return;
      }
      poolLinkage = {
        depositorId: player.id,
        lapId: makeLapId(),
        pairKey: activePair,
        creditConsumed: requiredCapital,
      };
    }

    // Direct-path tagging: tag the full required capital once. Paired
    // LAPs consume 2× a single LAP's capital but share one tag entry
    // (auction margin is fungible across the legs).
    let newTags = player.tags;
    if (!usePoolCredit) {
      const tagged = tryTag(player.margin, player.tags, "auctionMargin", requiredCapital);
      if (!tagged) {
        addToast("Insufficient free margin", "warning");
        return;
      }
      newTags = tagged;
    }

    // B-book routing decision. Only single (directional) LAPs route
    // via the pool — paired LAPs are delta-neutral so the pool has no
    // directional exposure to take. Pool-credit LAPs are also excluded
    // (separate collateral semantics). Falls back to peer (A) flow if
    // pool is over capacity or empty.
    let bBookContract = null;
    if (!paired && !usePoolCredit) {
      const route = routeFor({
        state: classifierState,
        userId: player.id,
        positionMargin: legSize,
      });
      if (route === "B") {
        const opened = openBBookContract({
          state: bBookState,
          userId: player.id,
          pairKey: activePair,
          side: player.side,
          leverage: player.leverage,
          margin: legSize,
          openPrice: priceNow,
          currentEpoch: activePS?.epochIndex ?? 0,
        });
        if (opened.ok) {
          bBookContract = opened.contract;
          setBBookState(opened.state);
        }
        // If pool refused (capacity / empty), silently fall back to
        // the peer-matched LAP path so user isn't blocked.
      }
    }

    const newPos = paired
      ? makePairedLap({
          pairKey: activePair,
          margin: requiredCapital, // total — each leg gets requiredCapital/2
          leverage: player.leverage,
          openPrice: priceNow,
          openedAtEpoch: activePS?.epochIndex ?? 0,
          poolLinkage,
        })
      : bBookContract
      ? {
          type: "bbook",
          bBookContractId: bBookContract.id,
          pairKey: activePair,
          side: player.side,
          leverage: player.leverage,
          margin: legSize,
          openPrice: priceNow,
          openedAtEpoch: activePS?.epochIndex ?? 0,
          poolLinkage: null,
        }
      : {
          pairKey: activePair,
          side: player.side,
          leverage: player.leverage,
          margin: legSize,
          openPrice: priceNow,
          openedAtEpoch: activePS?.epochIndex ?? 0,
          poolLinkage,
        };

    // Auto-publish rental offers for both legs of a paired LAP. Owners
    // can earn tip income when NPCs (or future humans) bid for
    // directional exposure without paying full LAP capital. Pool
    // linkage no longer mutates pair state — the linkage tag on the
    // position itself is the only record needed.
    if (paired) {
      setPairStates((prev) => {
        const target = prev[activePair];
        if (!target) return prev;
        const epochNow = target.epochIndex ?? 0;
        const longOffer = publishLegOffer({
          pairLapId: newPos.id,
          legSide: "long",
          ownerId: player.id,
          pairKey: activePair,
          publishedAtEpoch: epochNow,
        });
        const shortOffer = publishLegOffer({
          pairLapId: newPos.id,
          legSide: "short",
          ownerId: player.id,
          pairKey: activePair,
          publishedAtEpoch: epochNow,
        });
        return {
          ...prev,
          [activePair]: {
            ...target,
            rentalOffers: [...(target.rentalOffers ?? []), longOffer, shortOffer],
          },
        };
      });
    }

    setOpenPositions((prev) => [...prev, newPos]);
    if (!usePoolCredit) setPlayer((p) => ({ ...p, tags: newTags }));
    const labelTag = usePoolCredit
      ? "(pool credit)"
      : bBookContract
      ? "(B-book)"
      : "tagged";
    const label = paired
      ? `Opened ${activePair} PAIRED x${player.leverage.toFixed(1)} · $${requiredCapital.toFixed(0)} ${labelTag} · legs auto-listed for rent`
      : `Opened ${activePair} ${player.side} x${player.leverage.toFixed(1)} · $${legSize.toFixed(0)} ${labelTag}`;
    addToast(label, "info");
  }

  // --- Tower Tether handlers ----------------------------------------------
  //
  // Mint = open a thread. The same `amount` of free margin is locked as
  // the thread's underlying T-bill stake AND simultaneously deployed
  // as:
  //   - insurer-side fill across reinsurance-covered insurance markets
  //     (layer 2; mixed equal/size weighting)
  //   - B-book pool underwriter stake (layer 3; thread-derived stake
  //     that earns user tip flow + absorbs B-classed user P&L)
  //   - an equal amount of TT minted into the wallet (layer 4)
  //   plus auto-bought reinsurance face = 1.5× amount split across the
  //   3 reinsurance products, hedging the insurer-side exposure.
  //
  // No LTV gate, no coefficient — gate is purely "can you afford to
  // deploy `amount` of free margin?"
  function handleMintTT(amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      addToast("Mint amount must be positive", "warning");
      return;
    }
    const free = freeMargin(player.margin, player.tags);
    if (amount > free + 1e-6) {
      addToast(
        `Not enough free margin: $${free.toFixed(0)} available, need $${amount.toFixed(0)}`,
        "warning"
      );
      return;
    }

    // 1. Pick eligible markets and fill weights.
    const reinsuranceLive = (insuranceState.reinsurance ?? []).some(
      (p) => (p.sellerCapital ?? 0) > 0
    );
    const eligibleMarkets = insuranceState.markets ?? [];
    if (eligibleMarkets.length === 0) {
      addToast("No insurance markets available for thread", "warning");
      return;
    }
    const weights = calcInsuranceFillWeights({
      eligibleMarkets,
      reinsuranceLive,
    });

    // 2. Tag the principal as threadStake (locks same dollar across 4 roles).
    const newTags = tryTag(player.margin, player.tags, "threadStake", amount);
    if (!newTags) {
      addToast("Insufficient free margin (tag check)", "warning");
      return;
    }

    // 3. Layer 2: post insurer-side stakes weighted by the fill weights.
    let nextMarkets = insuranceState.markets;
    for (const [eventId, w] of Object.entries(weights)) {
      const fill = amount * w;
      if (fill <= 1e-6) continue;
      const idx = nextMarkets.findIndex((m) => m.eventId === eventId);
      if (idx < 0) continue;
      const r = postInsurer({
        market: nextMarkets[idx],
        userId: player.id,
        amount: fill,
      });
      if (r.ok) {
        nextMarkets = nextMarkets.map((m, i) => (i === idx ? r.market : m));
      }
    }

    // 3b. Auto-buy reinsurance — face = 1.5 × amount split across the 3
    //     products. Hedges the insurer-side exposure: if any market the
    //     thread participates in triggers, reinsurance pays the
    //     coverageFraction × loss back to the user.
    const reinsuranceFacePerProduct = (amount * 1.5) / 3;
    let nextReinsurance = insuranceState.reinsurance ?? [];
    nextReinsurance = nextReinsurance.map((p) => {
      const r = postReinsuranceBuyer({
        product: p,
        userId: player.id,
        faceAmount: reinsuranceFacePerProduct,
      });
      return r.ok ? r.product : p;
    });

    // 4. Layer 3: deposit the principal into the B-book pool as
    //    thread-derived stake. No lockup — it's gated by the thread
    //    redemption mechanics (10% cycle cap or express penalty).
    const adjusted = adjustThreadDerived({
      state: bBookState,
      uid: player.id,
      delta: amount,
    });
    if (!adjusted.ok) {
      addToast(`Mint failed: ${adjusted.reason}`, "warning");
      return;
    }

    // 5. Open the thread record. 1:1-mints the TT into the wallet.
    const opened = openThread({
      ttState,
      ownerId: player.id,
      principal: amount,
      insuranceWeights: weights,
      currentEpoch: activePS?.epochIndex ?? 0,
    });
    if (!opened.ok) {
      addToast(`Mint failed: ${opened.reason}`, "warning");
      return;
    }

    // 6. Commit all the new state in lockstep.
    setTtState(opened.ttState);
    setInsuranceState({
      ...insuranceState,
      markets: nextMarkets,
      reinsurance: nextReinsurance,
    });
    setBBookState(adjusted.state);
    setPlayer((p) => ({ ...p, tags: newTags }));
    addToast(
      `Thread opened: $${amount.toFixed(0)} → T-bill + insurance + B-book pool + TT (1 dollar, 4 jobs) · ${(reinsuranceFacePerProduct * 3).toFixed(0)} reinsurance face`,
      "info"
    );
  }

  function handleSendToMerchant(amount) {
    const result = transferTT({
      ttState,
      fromId: player.id,
      toId: "MERCHANT",
      amount,
    });
    if (!result.ok) {
      addToast(`Send failed: ${result.reason}`, "warning");
      return;
    }
    setTtState(result.ttState);
    addToast(`Sent ${amount.toFixed(0)} TT to merchant`, "info");
  }

  function handleRedeem(amount, express = false) {
    const result = submitRedemption({
      ttState,
      userId: player.id,
      amount,
      express,
      currentEpoch: activePS?.epochIndex ?? 0,
    });
    if (!result.ok) {
      addToast(`Redeem failed: ${result.reason}`, "warning");
      return;
    }
    setTtState(result.ttState);
    addToast(
      `Queued ${amount.toFixed(0)} TT for redemption (${express ? "EXPRESS — 5% penalty" : "standard"})`,
      express ? "warning" : "info"
    );
  }

  function handleCancelRedemption(requestId) {
    const result = cancelRedemption({ ttState, requestId });
    if (!result.ok) {
      addToast(`Cancel failed: ${result.reason}`, "warning");
      return;
    }
    setTtState(result.ttState);
    addToast("Redemption cancelled, TT returned to wallet", "info");
  }

  // --- B-book underwriter handlers ----------------------------------------
  function handleBBookDeposit(amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      addToast("Deposit must be positive", "warning");
      return;
    }
    const free = freeMargin(player.margin, player.tags);
    if (amount > free + 1e-6) {
      addToast(
        `Not enough free margin: $${free.toFixed(0)} available, need $${amount.toFixed(0)}`,
        "warning"
      );
      return;
    }
    const newTags = tryTag(player.margin, player.tags, "bBookStake", amount);
    if (!newTags) {
      addToast("Insufficient free margin (tag check)", "warning");
      return;
    }
    const epoch = activePS?.epochIndex ?? 0;
    const r = depositUnderwriter({
      state: bBookState,
      uid: player.id,
      amount,
      currentEpoch: epoch,
    });
    if (!r.ok) {
      addToast(`Deposit failed: ${r.reason}`, "warning");
      return;
    }
    setBBookState(r.state);
    setPlayer((p) => ({ ...p, tags: newTags }));
    addToast(
      `Staked $${amount.toFixed(0)} as B-book underwriter (locked ${(activePS?.epochIndex ?? 0)} → ${epoch + 100})`,
      "info"
    );
  }

  function handleBBookWithdraw(amount) {
    if (!Number.isFinite(amount) || amount <= 0) {
      addToast("Withdraw must be positive", "warning");
      return;
    }
    const epoch = activePS?.epochIndex ?? 0;
    const r = withdrawUnderwriter({
      state: bBookState,
      uid: player.id,
      amount,
      currentEpoch: epoch,
    });
    if (!r.ok) {
      addToast(`Withdraw failed: ${r.reason}`, "warning");
      return;
    }
    setBBookState(r.state);
    setPlayer((p) => ({
      ...p,
      tags: untag(p.tags ?? {}, "bBookStake", amount),
    }));
    addToast(`Withdrew $${amount.toFixed(0)} from B-book pool`, "info");
  }

  function handleResetSession() {
    clearPlayer();
    clearPositions();
    clearEquity();
    clearTrades();
    clearLedger();
    clearTt();
    clearInsurance();
    clearBBook();
    clearClassifier();
    clearPairStates();
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
      return;
    }
    // Defensive: surface unrecognized actions instead of silently
    // swallowing the click. The router can in principle emit other
    // actions (CLOSE_*, REBALANCE, etc.) — when it does, we'll see
    // it here rather than a dead button.
    addToast(`Router: action "${s.action}" not yet implemented`, "warning");
  }

  useKeyboardShortcuts({
    Space: () => setRunning((r) => !r),
    "1": () => setActiveTab("Chart"),
    "2": () => setActiveTab("Auction"),
    "3": () => setActiveTab("Insurance"),
    "4": () => setActiveTab("Credit"),
    "5": () => setActiveTab("B-book"),
    "6": () => setActiveTab("Stress"),
    "7": () => setActiveTab("Markets"),
    "8": () => setActiveTab("History"),
    "0": () => setActiveTab("Log"),
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
          className="md:hidden text-xs font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:border-gray-500 transition-colors"
          aria-label="Open instruments drawer"
        >
          ☰
        </button>
        <span className="font-syne text-lg text-indigo-400 tracking-tight">Trading Tower</span>

        {/* Compact at-a-glance summary: margin / allocated / TT / positions.
            Each chip is clickable where useful, and titles give detail on hover. */}
        <div className="flex items-center gap-1 flex-wrap">
          <HeaderChip
            label="Margin"
            value={`$${(player.margin ?? 0).toFixed(0)}`}
            color="text-gray-200 border-gray-700 bg-gray-900"
            title="Your free + tagged capital."
          />
          <HeaderChip
            label="Allocated"
            value={`$${poolDepositAmount.toFixed(0)}`}
            color={
              poolDepositAmount > 0
                ? "text-amber-300 border-amber-900 bg-amber-950/60"
                : "text-gray-500 border-gray-800 bg-gray-900"
            }
            title="Capital committed across insurance markets."
            onClick={() => setActiveTab("Insurance")}
          />
          <HeaderChip
            label="LTV"
            value={(poolLtvInfo?.ltv ?? 0).toFixed(2)}
            color={
              (poolLtvInfo?.ltv ?? 0) >= 0.6
                ? "text-emerald-300 border-emerald-900 bg-emerald-950/60"
                : "text-gray-400 border-gray-800 bg-gray-900"
            }
            title="Allocation diversification → mint capacity factor."
            onClick={() => setActiveTab("Credit")}
          />
          <HeaderChip
            label="Positions"
            value={`${openPositions.length}`}
            color={
              openPositions.length > 0
                ? "text-indigo-300 border-indigo-900 bg-indigo-950/60"
                : "text-gray-500 border-gray-800 bg-gray-900"
            }
            title="Open LAPs (single + paired)."
            onClick={() => setActiveTab("Credit")}
          />
          <HeaderChip
            label="TT"
            value={`$${(ttState?.balances?.[player.id] ?? 0).toFixed(0)}`}
            color={
              (ttState?.balances?.[player.id] ?? 0) > 0
                ? "text-emerald-200 border-emerald-700 bg-emerald-950"
                : "text-gray-500 border-gray-800 bg-gray-900"
            }
            title={`Tower Tether wallet · outstanding mint $${(ttState?.threads ?? []).filter((t) => !t.closed && t.ownerId === player.id).reduce((s, t) => s + t.ttFace, 0).toFixed(0)} · queue ${(ttState?.redemptionQueue ?? []).filter((q) => q.userId === player.id).length}`}
            onClick={() => setActiveTab("Insurance")}
          />
        </div>
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
            className="md:hidden text-xs font-mono px-2 py-1 rounded border border-indigo-700 bg-indigo-950/60 text-indigo-300 hover:bg-indigo-900/60 transition-colors"
            aria-label="Open position drawer"
          >
            pos
          </button>
          <button
            onClick={handleResetSession}
            className="text-xs font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-400 hover:text-gray-200 hover:bg-gray-700 hover:border-gray-500 transition-colors"
            title="Reset session (R)"
            aria-label="Reset session"
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
                  className="text-xs font-mono text-gray-500 hover:text-gray-200 px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
                  aria-label="Close instrument drawer"
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
            {TABS.map((t) => {
              const isActive = activeTab === t;
              return (
                <button
                  key={t}
                  onClick={() => setActiveTab(t)}
                  aria-current={isActive ? "page" : undefined}
                  className={cx(
                    "text-xs font-mono px-3 py-1 rounded transition-colors",
                    isActive
                      ? "bg-indigo-900 text-indigo-200"
                      : "text-gray-400 hover:text-gray-100 hover:bg-gray-800"
                  )}
                >
                  {t}
                </button>
              );
            })}
          </div>

          <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-3">
            {(activeTab === "Insurance" || activeTab === "Credit" || activeTab === "Chart") && (
              <GettingStarted
                hasAllocation={poolDepositAmount > 0}
                hasPosition={openPositions.length > 0}
                hasMinted={totalThreadPrincipal(ttState, player.id) > 0}
                hasMerchantSent={(ttState?.merchantBalance ?? 0) > 0}
                activeTab={activeTab}
                onJump={(t) => setActiveTab(t)}
              />
            )}

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
                <RoleLedger ledger={roleLedger} playerMargin={player.margin ?? 0} />
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
                    <div className="text-[10px] text-gray-500 mb-1">Insurance Allocation</div>
                    <div>Total stake: ${allocStats.totalStake.toFixed(0)}</div>
                    <div>Markets: {allocStats.numMarkets}</div>
                    <div>HHI: {allocStats.hhi.toFixed(2)}</div>
                    <div>Max weight: {(allocStats.maxWeight * 100).toFixed(0)}%</div>
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

            {activeTab === "Insurance" && (
              <>
                <InsuranceDesk
                  insuranceState={insuranceState}
                  playerId={player.id}
                  freeMarginToAllocate={freeMargin(player.margin, player.tags)}
                  poolLtv={poolLtvInfo}
                  onSetAllocation={handleSetAllocation}
                />
                <TtDesk
                  ttState={ttState}
                  playerId={player.id}
                  freeMargin={freeMargin(player.margin, player.tags)}
                  threadPrincipal={totalThreadPrincipal(ttState, player.id)}
                  onMint={handleMintTT}
                  onSendToMerchant={handleSendToMerchant}
                  onRedeem={handleRedeem}
                  onCancelRedemption={handleCancelRedemption}
                />
              </>
            )}

            {activeTab === "Credit" && (
              <>
                <CreditDesk poolLtv={poolLtvInfo} />
                <PortfolioStructurer
                  openPositions={openPositions}
                  creditEligibility={creditEligibility}
                  onOpen={handleOpenPosition}
                  onClose={handleClosePosition}
                  poolLtv={poolLtvInfo}
                  availablePoolCredit={availablePoolCredit}
                  poolDepositAmount={poolDepositAmount}
                  deployedPoolCredit={deployedPoolCredit}
                  rentalsByPair={rentalsByPair}
                />
                {openPositions.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <span className="text-[10px] font-mono text-gray-500 uppercase">
                      Position payoff curves
                    </span>
                    {openPositions.slice(0, 4).map((pos, idx) => (
                      <LapPayoffCurve
                        key={pos.id ?? idx}
                        position={pos}
                        currentPrice={pairStates[pos.pairKey]?.prices?.slice(-1)[0]}
                        label={
                          pos.type === "bbook"
                            ? `${pos.pairKey} ${pos.side} (B-book)`
                            : null
                        }
                      />
                    ))}
                  </div>
                )}
              </>
            )}

            {activeTab === "B-book" && (
              <BBookDesk
                bBookState={bBookState}
                playerId={player.id}
                freeMargin={freeMargin(player.margin, player.tags)}
                currentEpoch={activePS?.epochIndex ?? 0}
                onDeposit={handleBBookDeposit}
                onWithdraw={handleBBookWithdraw}
              />
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
            poolLtv={poolLtvInfo}
            availablePoolCredit={availablePoolCredit}
            deployedPoolCredit={deployedPoolCredit}
            classifierStats={getClassifierStats(classifierState, player.id)}
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
                  className="text-xs font-mono text-gray-500 hover:text-gray-200 px-2 py-0.5 rounded hover:bg-gray-800 transition-colors"
                  aria-label="Close position drawer"
                >
                  ×
                </button>
              </div>
              <PlayerPanel
                player={player}
                onUpdate={handlePlayerUpdate}
                activePair={activePair}
                cap={cap}
                poolLtv={poolLtvInfo}
                availablePoolCredit={availablePoolCredit}
                deployedPoolCredit={deployedPoolCredit}
                classifierStats={getClassifierStats(classifierState, player.id)}
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
        className="fixed bottom-4 left-4 z-40 text-[10px] font-mono px-3 py-1 rounded-full border border-gray-700 bg-gray-900 text-gray-400 hover:text-gray-100 hover:bg-gray-800 hover:border-indigo-500 transition-colors"
        aria-label="Open tutorial"
      >
        ? tutorial
      </button>
    </div>
  );
}
