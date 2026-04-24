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
import { calcPoolLtv, calcAvailablePoolCredit } from "./lib/ltv.js";
import {
  makeLapId,
  linkLapToDeposit,
  unlinkLapFromDeposit,
  applyPoolToLapHaircut,
} from "./lib/poolLinkage.js";
import { getEffectiveCap } from "./lib/esma.js";
import { initStrip } from "./lib/strips.js";
import { createOffer, matchBorrowRequest, cancelOffer } from "./lib/lending.js";
import { initLedger } from "./lib/roleLedger.js";
import { initTags, tryTag, untag, freeMargin } from "./lib/capitalTags.js";
import { initGovernance } from "./lib/governance.js";
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
import { RoleLedger } from "./components/RoleLedger.jsx";
import { GovernancePanel } from "./components/GovernancePanel.jsx";

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
  tags: initTags(), // §10.1 — capital accumulates roles via tags, not transfers
};

const TABS = ["Chart", "Auction", "Derivatives", "Lending", "Credit", "Stress", "Markets", "Governance", "History", "Log"];

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
  const [roleLedger, setRoleLedger, clearLedger] = usePersistentState(
    "tt.roleLedger",
    initLedger()
  );
  const [governance, setGovernance, clearGovernance] = usePersistentState(
    "tt.governance",
    initGovernance()
  );

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

  // Pool → LAP haircut propagation. Pool settlement (slow tick) writes
  // pendingLapHaircutPct on the pool state; this effect runs on the next
  // render (which is the next medium-tick cycle's render) and applies
  // the haircut to linked positions, then clears the queue. The
  // different-render separation is what keeps the two subsystems from
  // mutating the same position in the same frame.
  useEffect(() => {
    const anyQueued = ACTIVE_PAIRS.some(
      (pk) =>
        Object.keys(pairStates[pk]?.insurancePool?.pendingLapHaircutPct ?? {})
          .length > 0
    );
    if (!anyQueued) return;

    ACTIVE_PAIRS.forEach((pk) => {
      const pool = pairStates[pk]?.insurancePool;
      if (!pool?.pendingLapHaircutPct) return;
      if (Object.keys(pool.pendingLapHaircutPct).length === 0) return;

      const { positions: nextPositions, pool: nextPool } = applyPoolToLapHaircut(
        pool,
        openPositions
      );

      // Position state: uniformly reduced margin on linked LAPs.
      if (nextPositions !== openPositions) {
        setOpenPositions(nextPositions);
        addToast("Pool claim propagated to linked LAPs", "warning");
      }

      // Clear the queue on the pool.
      setPairStates((prev) => ({
        ...prev,
        [pk]: {
          ...prev[pk],
          insurancePool: nextPool,
        },
      }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairStates]);

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

  // Pool deposit total across all pairs' pools (a depositor can hold
  // slices in multiple pools; for the credit budget they sum).
  const poolDepositAmount = useMemo(() => {
    return ACTIVE_PAIRS.reduce((sum, pk) => {
      const dep = pairStates[pk]?.insurancePool?.deposits?.[player.id];
      return sum + (dep?.amount ?? 0);
    }, 0);
  }, [pairStates, player.id]);

  // Deployed credit — sum of creditConsumed across all linked LAPs in
  // the depositor's pool slices.
  const deployedPoolCredit = useMemo(() => {
    return ACTIVE_PAIRS.reduce((sum, pk) => {
      const dep = pairStates[pk]?.insurancePool?.deposits?.[player.id];
      return sum + (dep?.deployedCredit ?? 0);
    }, 0);
  }, [pairStates, player.id]);

  const poolLtvInfo = useMemo(() => calcPoolLtv(openPositions), [openPositions]);
  const availablePoolCredit = useMemo(
    () => calcAvailablePoolCredit(poolDepositAmount, openPositions, deployedPoolCredit),
    [poolDepositAmount, openPositions, deployedPoolCredit]
  );

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
      initialPositions,
      activePS?.epochIndex ?? 0
    );
  }, [equityHistory, openPositions, initialPositions, activePair, activePS]);

  const creditEligibility = useMemo(
    () =>
      Object.fromEntries(
        ACTIVE_PAIRS.map((pk) => [
          pk,
          calcPairCreditEligibility(pk, creditAssessment.creditScore, openPositions),
        ])
      ),
    [creditAssessment, openPositions]
  );

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

  // --- Contract / strip / pool handlers (§10.1 same-capital semantics) ---
  //
  // Cash-flow operations (pay premium, receive payout) change `margin`.
  // Role operations (deposit, open position, post offer) only tag a slice
  // of margin as serving that role — margin itself is untouched.

  function handleBuyImbalance({ size, direction, strikeImbalance, premium }) {
    const id = `IMB-${Date.now()}`;
    const cost = size * premium;
    // Premium is a real cash flow (paid to insurer).
    if (cost > player.margin) return;
    // Collateralise the contract: tag `size` as backing this obligation.
    const newTags = tryTag(player.margin - cost, player.tags, "contractCollateral", size);
    if (!newTags) {
      addToast("Insufficient free margin to collateralise contract", "warning");
      return;
    }
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return {
        ...prev,
        [activePair]: {
          ...ps,
          imbalanceContracts: [
            ...ps.imbalanceContracts,
            { id, buyerId: player.id, size, direction, strikeImbalance, premium },
          ],
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost, tags: newTags }));
    addToast(`Imbalance ${direction} · premium $${cost.toFixed(2)}`, "info");
  }

  function handleBuyEntropy({ size, lockedMult, premium }) {
    const id = `ENT-${Date.now()}`;
    const cost = size * premium;
    if (cost > player.margin) return;
    const newTags = tryTag(player.margin - cost, player.tags, "contractCollateral", size);
    if (!newTags) {
      addToast("Insufficient free margin to collateralise contract", "warning");
      return;
    }
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return {
        ...prev,
        [activePair]: {
          ...ps,
          entropyContracts: [
            ...ps.entropyContracts,
            { id, buyerId: player.id, size, lockedMult, premium },
          ],
        },
      };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost, tags: newTags }));
    addToast(`Entropy lock ${lockedMult.toFixed(1)}× · premium $${cost.toFixed(2)}`, "info");
  }

  function handleBuyStrip(params) {
    const strip = {
      ...initStrip({
        id: `STRIP-${Date.now()}`,
        ...params,
        yieldModel: activePS?.yieldModel,
      }),
      buyerId: player.id,
    };
    const cost = strip.margin * strip.premium;
    if (cost > player.margin) return;
    const tagAmount = strip.margin * strip.protectedFraction;
    const newTags = tryTag(player.margin - cost, player.tags, "contractCollateral", tagAmount);
    if (!newTags) {
      addToast("Insufficient free margin to collateralise strip", "warning");
      return;
    }
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      return { ...prev, [activePair]: { ...ps, strips: [...ps.strips, strip] } };
    });
    setPlayer((p) => ({ ...p, margin: p.margin - cost, tags: newTags }));
    addToast(`Strip ${(strip.protectedFraction * 100).toFixed(0)}% × ${strip.epochs}ep · premium $${cost.toFixed(2)}`, "info");
  }

  // Pool deposit is a TAG — no margin transfer (§10.1).
  function handleDeposit(amount) {
    const newTags = tryTag(player.margin, player.tags, "poolDeposit", amount);
    if (!newTags) {
      addToast("Insufficient free margin to tag for pool", "warning");
      return;
    }
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
    setPlayer((p) => ({ ...p, tags: newTags }));
    addToast(`Tagged $${amount} as pool collateral (margin untouched)`, "info");
  }

  // Pool withdraw releases the tag — no margin transfer.
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
    setPlayer((p) => ({ ...p, tags: untag(p.tags, "poolDeposit", amount) }));
    addToast(`Released $${amount} pool tag (margin untouched)`, "info");
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

    // Pool-linked LAPs un-link on close. Voluntary closes at a loss
    // queue a proportional pool haircut; gains / break-even un-link
    // cleanly (user decision 4).
    if (pos.poolLinkage) {
      const lossPct = pnl < 0 ? Math.min(1, -pnl / Math.max(1e-8, pos.margin)) : 0;
      setPairStates((prev) => {
        const target = prev[pos.poolLinkage.pairKey];
        if (!target) return prev;
        return {
          ...prev,
          [pos.poolLinkage.pairKey]: {
            ...target,
            insurancePool: unlinkLapFromDeposit(
              target.insurancePool,
              pos.poolLinkage.depositorId,
              pos.poolLinkage.lapId,
              lossPct
            ),
          },
        };
      });
    }

    setOpenPositions((prev) => prev.filter((_, idx) => idx !== i));
    setTradeLog((prev) => [...prev, { ...pos, pnl, closedPrice: priceNow }]);
    // P&L is a real cash flow; auction-margin tag is released.
    setPlayer((p) => ({
      ...p,
      margin: p.margin + pnl,
      tags: untag(p.tags, "auctionMargin", pos.margin),
    }));
    addToast(
      `Closed ${pos.pairKey} ${pos.side}: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}${pos.poolLinkage ? " (pool-linked)" : ""}`,
      pnl >= 0 ? "info" : "warning"
    );
  }

  function handleOpenPosition(opts = {}) {
    const { usePoolCredit = false } = opts;
    const priceNow = activePS?.prices?.slice(-1)[0] ?? 1;
    const size = Math.min(1000, freeMargin(player.margin, player.tags) * 0.2);
    if (size < 100) {
      addToast("Not enough free margin to open position", "warning");
      return;
    }

    // If the user wants pool-backed credit, verify there's enough headroom
    // BEFORE tagging. A pool-backed LAP uses `size` of the depositor's
    // available credit (not free margin).
    let poolLinkage = null;
    if (usePoolCredit) {
      const availableCredit = calcAvailablePoolCredit(
        poolDepositAmount,
        openPositions,
        deployedPoolCredit
      );
      if (availableCredit < size) {
        addToast(
          `Not enough pool credit: $${availableCredit.toFixed(0)} available, need $${size.toFixed(0)}`,
          "warning"
        );
        return;
      }
      poolLinkage = {
        depositorId: player.id,
        lapId: makeLapId(),
        pairKey: activePair, // deposit lives on the active pair's pool
        creditConsumed: size,
      };
    }

    // Non-pool path uses auctionMargin tag (§10.1). Pool-backed path
    // doesn't consume the user's margin — the credit comes from their
    // deposit slice, already held in the pool. Tag only the direct path.
    let newTags = player.tags;
    if (!usePoolCredit) {
      const tagged = tryTag(player.margin, player.tags, "auctionMargin", size);
      if (!tagged) {
        addToast("Insufficient free margin", "warning");
        return;
      }
      newTags = tagged;
    }

    const newPos = {
      pairKey: activePair,
      side: player.side,
      leverage: player.leverage,
      margin: size,
      openPrice: priceNow,
      openedAtEpoch: activePS?.epochIndex ?? 0,
      poolLinkage,
    };

    if (poolLinkage) {
      setPairStates((prev) => {
        const target = prev[poolLinkage.pairKey];
        if (!target) return prev;
        return {
          ...prev,
          [poolLinkage.pairKey]: {
            ...target,
            insurancePool: linkLapToDeposit(
              target.insurancePool,
              poolLinkage.depositorId,
              poolLinkage.lapId,
              size
            ),
          },
        };
      });
    }

    setOpenPositions((prev) => [...prev, newPos]);
    setInitialPositions((prev) => (prev.length === 0 ? [newPos] : [...prev, newPos]));
    if (!usePoolCredit) setPlayer((p) => ({ ...p, tags: newTags }));
    addToast(
      `Opened ${activePair} ${player.side} x${player.leverage.toFixed(1)} · $${size.toFixed(0)}${usePoolCredit ? " (pool credit)" : " tagged"}`,
      "info"
    );
  }

  // --- Lending handlers (§10.1 same-capital semantics) ---
  function handlePostLendingOffer({ amount, rate, duration }) {
    const newTags = tryTag(player.margin, player.tags, "lendingOffered", amount);
    if (!newTags) {
      addToast("Insufficient free margin to offer", "warning");
      return;
    }
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
    setPlayer((p) => ({ ...p, tags: newTags }));
    addToast(`Tagged $${amount} @ ${(rate * 100).toFixed(3)}% as lending (margin untouched)`, "info");
  }

  function handleCancelLendingOffer(offerId) {
    setPairStates((prev) => {
      const ps = prev[activePair];
      if (!ps) return prev;
      const offer = ps.lendingOffers.find((o) => o.id === offerId);
      if (!offer || offer.lenderId !== player.id) return prev;
      const release = offer.remaining;
      if (release > 0) {
        setPlayer((p) => ({ ...p, tags: untag(p.tags, "lendingOffered", release) }));
      }
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
    clearLedger();
    clearGovernance();
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
    "8": () => setActiveTab("Governance"),
    "9": () => setActiveTab("History"),
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
                  poolLtv={poolLtvInfo}
                  availablePoolCredit={availablePoolCredit}
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
                  poolLtv={poolLtvInfo}
                  availablePoolCredit={availablePoolCredit}
                  poolDepositAmount={poolDepositAmount}
                  deployedPoolCredit={deployedPoolCredit}
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

            {activeTab === "Governance" && (
              <GovernancePanel
                governance={governance}
                setGovernance={setGovernance}
                playerId={player.id}
                currentEpoch={activePS?.epochIndex ?? 0}
                playerContext={{
                  poolLoyaltyEpochs:
                    (activePS?.insurancePool?.deposits?.[player.id]?.depositEpoch != null)
                      ? (activePS?.epochIndex ?? 0) -
                        (activePS?.insurancePool?.deposits?.[player.id]?.depositEpoch ?? 0)
                      : 0,
                  openPositions,
                  creditQualified: creditAssessment.qualified,
                  contractsWritten:
                    (activePS?.imbalanceContracts?.length ?? 0) +
                    (activePS?.entropyContracts?.length ?? 0) +
                    (activePS?.strips?.length ?? 0),
                  lendingOffers: (activePS?.lendingOffers ?? []).filter(
                    (o) => o.lenderId === player.id && o.active
                  ).length,
                  timeInProtocolEpochs: activePS?.epochIndex ?? 0,
                }}
              />
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
            creditMultiplier={creditAssessment.multiplier}
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
        className="fixed bottom-4 left-4 z-40 text-[10px] font-mono px-3 py-1 rounded-full border border-gray-700 bg-gray-900 text-gray-400 hover:text-gray-100 hover:bg-gray-800 hover:border-indigo-500 transition-colors"
        aria-label="Open tutorial"
      >
        ? tutorial
      </button>
    </div>
  );
}
