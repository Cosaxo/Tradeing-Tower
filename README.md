# Trading Tower

In-browser simulator for a closed financial protocol where **one dollar
plays four roles at once**. The protocol's mint unit ("a thread") is the
hyper-rehypothecated atom: principal, insurance-seller stake,
B-book pool stake, and stablecoin (TT) face — all backed by the same
$1 of margin. Damage to any role shrinks all four in lockstep; growth
fattens layers 1–3 (TT face is intentionally non-elastic so a
collateral buffer accumulates).

The simulator is conservation-tested end-to-end: every cash flow has a
named counterparty, the books balance globally, and `Math.random()`
appears in exactly one module (the GBM price stepper).

```
npm install
npm run dev   # → http://localhost:5173
```

## What the protocol actually is

Three independent design ideas wired into one closed system:

1. **The thread** (`lib/towerTether.js`) — a stablecoin (Tower Tether)
   minted 1:1 against free margin. Each minted dollar simultaneously
   holds:
   - **Layer 1** — T-bill principal (the dollar itself).
   - **Layer 2** — insurance-seller stakes spread across reinsurance-
     covered event markets (`insuranceWeights[eventId]`, ∑ ≈ 1).
   - **Layer 3** — B-book pool underwriter stake
     (`bBookState.underwriters[uid].threadDerivedStake`).
   - **Layer 4** — TT face in circulation (`thread.ttFace`).

   Loss to any layer → `damageThread` writes down all four in lockstep.
   Gain → `growThread` fattens layers 1–3 only; `ttFace` is unchanged
   so subsequent damage eats the buffer before TT supply contracts.

2. **The transparent A/B classifier** (`lib/userClassifier.js`) — every
   user's rolling 10-close score is fully visible: components, current
   class, gap to A. B-classified flow that can't peer-match routes to
   the **B-book pool** (`lib/bBookPool.js`), an opt-in counterparty
   marketplace where underwriters absorb directional P&L in exchange
   for tip income. Whale exception: a single bet > 2× rolling-average
   margin force-classes to A so a "lose small, bet big" gambit can't
   silently drain the pool.

3. **The LAP auction** (`lib/auction.js`) — leveraged-auction clearing
   with a geodesic (bimodal log-normal in log-leverage space) ideal
   distribution; entropy-weighted tip premium for thin buckets;
   self-calibrating meta-parameters via KL-gradient descent on the
   actual-vs-ideal fill curve. Matching is sort-and-align (provably
   minimises Σ |L_long − L_short|), continuous fill at min(longMax,
   shortMax). Skew/kurtosis from the live book apply a Cornish-Fisher
   2nd-order correction to the ideal density.

## Architecture

### Epoch loop — three strides + a redemption stride

| Stride     | Cadence                       | Responsibility                                                         |
| ---------- | ----------------------------- | ---------------------------------------------------------------------- |
| Fast       | `FAST_MS` (~1 s)              | price advance + realised-σ update                                      |
| Medium     | `MEDIUM_MS` (~6 s)            | order-flow ingest, auction, pool settle, rentals, insurance + reinsurance |
| Slow       | every `SLOW_EVERY` mediums    | regime detection, cross-pair correlation                               |
| Redemption | every `REDEMPTION_EVERY` mediums (~monthly in sim-days; coprime with slow) | TT redemption queue drain + thread unwinds + solvency recheck |

Speed control (½× / 1× / 2× / 5×) scales fast and medium intervals
proportionally. The medium tick uses a strict pure-compute → side-effect
pattern: one `next` map and one `sideEffects` accumulator are built
synchronously, then setters run exactly once in an apply phase. No
setter runs from inside another setter's updater (this avoids React 18
StrictMode dev-mode double-invocation doubling every cash flow).

### Core lib (`src/lib/`)

| Module              | Purpose                                                                                              |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| `towerTether.js`    | Threads, mint, `damageThread` / `growThread`, redemption cycle, solvency recheck, debt accounting.   |
| `bBookPool.js`      | Voluntary + thread-derived underwriter stake; `openContract` / `closeContract`; B-long ↔ B-short pre-pool match; capacity gate (`BBOOK_MAX_NOTIONAL_RATIO`). |
| `userClassifier.js` | Rolling 10-close score (avgReturn / winRate / Sharpe), A-threshold = 0.05, whale exception, fully-visible breakdown. |
| `auction.js`        | Geodesic distribution, entropy weights, KL-gradient meta-param adaptation, sort-and-align matching.  |
| `pairedLap.js`      | Single delta-neutral object holding both legs at one leverage; positive-gamma payoff math.           |
| `rentalMarket.js`   | Per-leg rental of paired LAPs — offers, bids, settlement, default propagation back into LAP margin.  |
| `insuranceMarket.js`| Two-sided binary-payout markets — insurer / insured posting, supply-demand premium rate, per-tick settle. |
| `insuranceEvents.js`| Standard event registry + `detectTriggeredEvents` (per-pair price moves + macro conditions).        |
| `reinsurance.js`    | Three parallel products (30 / 30 / 40 % coverage); long seller lockup; insurance-side claim pass-through. |
| `allocations.js`    | User vector `{ eventId → pct }`; LAP P&L propagates pro-rata into allocation stakes.                 |
| `ltv.js`            | Allocation diversification → effective LTV; available-credit calculation.                            |
| `capitalTags.js`    | Per-role tagging on margin (`principal`, `threadStake`, …) for free-margin / role-decomposition UI. |
| `roleLedger.js`     | Per-epoch attribution (tbill / auctionPnl / tips / poolYield / stripPnl / creditChange).             |
| `pool.js`           | Risk-tiered SAFE/MEDIUM/RISKY cascade settlement on continuous-ambient flow (NPCs only).             |
| `priceModels.js`    | GBM / Merton jump-diffusion / mean-revert / leverage-effect dispatcher. Only source of randomness.   |
| `regime.js`         | Three-signal (trend, volRatio, autocorr) regime detection.                                           |
| `correlation.js`    | Cross-pair correlation matrix.                                                                       |
| `stress.js`         | Shock propagation through correlated pairs, system-wide solvency buffer.                             |
| `esma.js`           | ESMA Reg 2018/796 caps + vol-adaptive cap `min(ESMA, 1/(σ·√t·K))`.                                   |
| `math.js`           | Pure stats: Sortino, Calmar, correlation, realised-σ, ratio-β, ratio-effective σ.                    |
| `yieldModel.js`     | OU mean-reverting auction-tip yield model.                                                           |
| `yieldRouter.js`    | Ranked actionable yield opportunities per pair (UI helper).                                          |
| `orderFlow.js`      | Schema guards (`isValidAuctionBid` / `isValidPoolUser` / `isValidRentalBid`) at the adapter boundary. |
| `brokerAdapter.js`  | `OrderFlowAdapter` interface — pluggable source of market flow.                                      |
| `defaultBotAdapter.js` | NPC-driven adapter (the legacy in-process bot pool).                                              |
| `replayAdapter.js`  | Replay adapter for recorded tapes (deterministic re-runs from a seed).                               |
| `npcs.js`           | Five NPC profiles (Whale, Degen, Hedger, Bot, Bear) with regime-overlay adaptation.                  |
| `npcMarkets.js`     | NPC-side rental-bid generator.                                                                       |
| `credit.js`         | Allocation-share-based credit eligibility for paired-LAP opens.                                      |
| `conservation.js`   | Invariant checker — every cash-flow tick should net to zero across counterparties.                   |
| `settlement.js`     | Geometric P&L + Harrison (1985) analytical barrier formula `P(τ ≤ T) = exp(-2ab/σ²)`.                |
| `insuranceEvents.js`| Standard event set + `detectTriggeredEvents`.                                                        |

All lib modules are pure functions of their inputs — no module-level
mutable state, no React, no DOM. The only exception is per-module
monotonic ID counters used to mint stable identifiers.

### State (`src/state/`)

`initPairState(pairKey)` builds a per-instrument state: prices, return
history, NPC book mirror, regime, regime history, yield model, ratio
history, fee ledger, rental orderbook, active rentals, events.

`initInsuranceState()` builds the global insurance + reinsurance +
allocations + classifier state — single object shared across all pairs.

### Hooks (`src/hooks/`)

| Hook                  | Role                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `useEpochLoop`        | Orchestrates fast / medium / slow / redemption strides. Operates on refs, applies setters once. |
| `useToast`            | Ephemeral notifications.                                                                      |
| `useKeyboardShortcuts`| Declarative global key bindings (ignores when input is focused).                              |
| `usePersistentState`  | `useState` wrapper that hydrates from / syncs to `localStorage`.                              |

### UI (`src/components/`)

| Component             | Purpose                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------- |
| `InstrumentSelector`  | 18-pair grid with sparklines + % return.                                                           |
| `PriceChart`          | Price + regime band, tick grid, % return.                                                          |
| `LeverageCurve`       | Ideal (geodesic) vs actual fill curve per side.                                                    |
| `LapPayoffCurve`      | Paired-LAP gamma payoff visualisation.                                                             |
| `PlayerPanel`         | Sliders for leverage / margin / side, presets, tip-tier editor.                                    |
| `MetricsPanel`        | Equity curve + Sortino / Calmar / WinRate / MaxDD.                                                 |
| `TipTierEditor`       | Per-tier tip configuration.                                                                        |
| `PortfolioStructurer` | Open / close paired LAPs against allocations; eligibility checks.                                  |
| `InsuranceDesk`       | Allocation editor, market browser, reinsurance buyer/seller flows.                                 |
| `TtDesk`              | Mint / transfer / redeem TT; thread inspector; merchant simulator.                                 |
| `BBookDesk`           | Underwriter deposit / withdraw, capacity, pool P&L + utilisation; classifier breakdown.            |
| `CreditDesk`          | LTV breakdown driven by allocation diversification.                                                |
| `FeeFlow`             | Visual flow of cash between counterparties this tick.                                              |
| `RoleLedger`          | Per-epoch attribution (tbill / tips / pool yield / strip P&L / credit Δ).                          |
| `CapitalBreakdown`    | Margin decomposed by capital tag.                                                                  |
| `CorrelationHeatmap`  | Cross-pair correlation matrix.                                                                     |
| `RegimeTimeline`      | Segmented timeline of regime transitions.                                                          |
| `StressPanel`         | System solvency + shock scenario.                                                                  |
| `NpcPanel`            | NPC book snapshot for the active pair.                                                             |
| `NotificationHistory` | Toast log.                                                                                         |
| `TradeHistory`        | Closed-trade ledger with P&L.                                                                      |
| `LogicView`           | Scrollable epoch log with tag-coloured lines.                                                      |
| `SpeedControl`        | ½× / 1× / 2× / 5× tempo.                                                                           |
| `GettingStarted`      | Four-step onboarding (allocate → open position → mint TT → spend at merchant).                     |
| `Tutorial`            | First-run walkthrough overlay.                                                                     |
| `Sparkline` / `Tooltip` / `ErrorBoundary` | UI primitives.                                                                |

## Onboarding flow

The four-step `GettingStarted` panel mirrors the protocol's actual capital
path:

1. **Allocate margin to insurance markets** — diversification raises
   your effective LTV.
2. **Open a position** — single or paired LAP, funded against the
   allocation.
3. **Mint Tower Tether** — once your LTV ≥ 0.6, mint TT. Reinsurance is
   auto-purchased to hedge the insurer-side exposure.
4. **Send TT to the merchant** — simulates a real-world payment;
   merchant queues redemption pro-rata each cycle so you can watch the
   thread unwind.

## Keyboard shortcuts

| Key       | Action                                                  |
| --------- | ------------------------------------------------------- |
| `Space`   | Start / pause                                           |
| `1` – `8` | Switch tab (Chart, Auction, Insurance, Credit, B-book, Stress, Markets, History) |
| `0`       | Log tab                                                 |
| `+` / `-` | Speed up / down                                         |
| `r`       | Reset session                                           |

## Design principles

1. **Conservation first.** Every cash flow has a named counterparty.
   `conservation.test.js` and `integration.test.js` enforce that
   per-tick net flow across all participants is zero.
2. **Deterministic where it matters.** Settlement is reproducible from
   a seed. Randomness is contained to `priceModels.js`; barrier checks
   use the Harrison (1985) analytical formula.
3. **Self-calibrating auction.** Geodesic meta-params (`muLow`,
   `alpha`, `sigmaMix`, `muHigh`) adapt per epoch via KL-gradient
   descent on actual-vs-ideal bucket fills — no hardcoded equilibrium.
4. **Transparent classification.** A/B routing is visible end-to-end:
   score, components, current class, and the exact gap to A. The
   conflict of interest of traditional CFD B-booking becomes a
   transparent open marketplace with explicit consent.
5. **Layer lockstep.** Thread layers grow and shrink atomically; the
   epoch loop enforces that insurance damage and LAP damage cannot land
   on the same thread in the same epoch (the "epoch-separation
   invariant").
6. **Pluggable order flow.** The auction is agnostic to its source —
   `defaultBotAdapter`, `replayAdapter`, and a stub `brokerAdapter` all
   satisfy the same interface. Schema guards in `orderFlow.js` strip
   malformed entries at the adapter boundary.
7. **Pure lib, hooks isolated.** Every lib module is a pure function of
   its inputs. React lives only in `src/hooks/` and `src/components/`.

## Testing

```
npm run test          # run once
npm run test:watch    # watch mode
```

27 unit + integration test files cover: math, ESMA caps, deterministic
settlement, auction matching + entropy, insurance markets, reinsurance,
rentals, paired LAPs, B-book pool (open/close/capacity), classifier
scoring + whale exception, allocations, LTV, capital tags, role
ledger, NPC markets, order-flow guards, regime detection,
cross-market correlation, stress propagation, conservation invariants,
yield model, yield router, and Tower Tether (mint, damage, growth,
redemption cycle, solvency clawback).

## Scripts

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `npm run dev`        | Vite dev server on :5173                       |
| `npm run build`      | Production build into `dist/`                  |
| `npm run preview`    | Serve the production build                     |
| `npm run lint`       | ESLint                                         |
| `npm run format`     | Prettier on `src/**`                           |
| `npm run test`       | Vitest unit + integration suite                |
| `npm run test:watch` | Vitest in watch mode                           |

## State persistence

`usePersistentState` saves player config, open positions, equity
history, closed trades, TT state, insurance state, B-book state, and
the role ledger to `localStorage` under `tt.*` keys. Press **`r`** (or
the reset button in the header) to wipe the session.

## License

MIT.
