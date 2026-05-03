# Trading Tower

**A retail-yield product built on a single idea: the same $1 should be
allowed to earn from four uncorrelated sources at the same time.**

You deposit one dollar. Without ever moving it, that dollar simultaneously:

1. **Earns T-bill yield** as principal.
2. **Earns insurance premium income** as an insurance seller across
   diversified event markets.
3. **Earns B-book pool yield** as the counterparty to losing trader
   flow (passive underwriter — you don't trade, you absorb).
4. **Backs Tower Tether (TT)**, a stablecoin you can spend like cash.

These four roles are wired together as a single object — a *thread* —
so the dollar is never duplicated and the protocol's accounting books
balance globally. Damage in any role shrinks all four in lockstep;
growth fattens layers 1–3 and accumulates as a buffer. The safety
property is **not** "each layer never loses money" — it is **"the
joint outcome across all four layers is positive with very high
probability under realistic stress."** The four sources are chosen
specifically to be uncorrelated so the joint distribution is much
tighter than any single layer.

```
npm install
npm run dev   # → http://localhost:5173
```

## Two ways to use it

**Easy mode (default for new users)** — one button. *Convert $X → TT*.
The protocol auto-runs all four layers in the safe-by-default
configuration: even allocation across diversified markets, full
reinsurance coverage, B-book pool stake, TT mint. You see one number:
today's yield. Withdraw at any time.

**Advanced mode** — every layer is exposed as a separate desk:
allocation editor, reinsurance buyer/seller flows, paired-LAP auction
clearing, B-book underwriter desk, classifier breakdown. For users who
want to actively trade, configure their own allocations, or run the
protocol manually.

## The four-tier ladder

Capital climbs the ladder. Each rung adds an uncorrelated yield source
on top of the previous rungs. Higher rungs require evidence that the
position is safe enough to qualify.

| Tier | What it does | Gate to enter |
| :--: | :-- | :-- |
| **1** | T-bill principal — the dollar itself | none |
| **2** | Insurance-seller stake across event markets | none |
| **3** | LAP exposure (active trading) | ≥3 markets allocated; max 50% any single; reinsurance bought (enforced by `evaluateTier3Gate` at LAP open) |
| **4** | TT mint (the dollar plays all four roles) | layer-3 role of the thread is **B-book stake**, not active LAP — capital you've minted is locked as passive underwriter; capital you haven't minted is free to actively trade |

**LTV** (`lib/ltv.js`) tracks the user's progress toward the ceiling
through five additive terms — concentration, diversity, breadth,
reinsurance coverage, and correlation independence — minus a
max-weight penalty if any single market dominates. Pure diversification
caps below the ceiling; LTV → 1.0 only when the user *also* buys
reinsurance covering enough of their insurer-side exposure AND the
allocations span uncorrelated underlyings.

Tier 4 enforces an important separation: a thread that has been minted
into TT cannot also be an active-LAP. Active trading and TT-backing are
**per-thread** mutually exclusive — capital you've minted is locked as
B-book underwriter; capital you haven't minted is free to actively
trade. This is what makes the joint-outcome safety claim defensible:
the layer-3 role of a TT thread is a passive yield source, not a
directional bet.

## The trading venue (secondary value prop)

Trading Tower is a real multi-user trading platform — there are no
synthetic NPCs, no in-process bots. Every counterparty is another
human user. Solo demo mode shows the protocol idle (T-bill yield +
insurance + reinsurance still settle); auction matches require at
least one peer.

Because the auction uses a **geodesic** ideal leverage distribution
with **entropy-weighted tips**, taking the unpopular side of the book
is rewarded:

- **No commissions, no spread.** The auction matches bids directly.
- **Minority-side rebate.** When the book is tilted long, the entropy
  multiplier pays shorts a tip premium proportional to KL divergence
  from the ideal distribution. Same in reverse. Effectively negative
  cost of leverage on the unpopular side.
- **Fast, deterministic clearing.** Each medium tick closes one
  auction with a single match-and-fill pass.
- **Transparent A/B classifier.** Every user sees their own score and
  whether they're being routed peer-to-peer (A) or against the B-book
  pool (B). No hidden conflict of interest.

### Multi-user wiring

The platform's order-flow seam (`OrderFlowAdapter`) is pluggable. The
default in this codebase is **`LocalBroadcastAdapter`** — each browser
tab is one user, and tabs in the same room exchange bids via
`BroadcastChannel`. Two open tabs on the same machine give a working
multi-user demo without any backend. A real production deployment
swaps in a server-backed adapter (the same interface) and shares
protocol-global state (insurance, reinsurance, B-book, TT) across
users — the demo's known limitation is that protocol state is
per-tab.

## Under the hood

Three design ideas wired into one conservation-tested system:

1. **The thread** (`lib/towerTether.js`) — a stablecoin minted 1:1
   against free margin. Each minted dollar simultaneously holds:
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

The simulator is conservation-tested end-to-end: every cash flow has a
named counterparty, the books balance globally, and `Math.random()`
appears in exactly one module (the GBM price stepper).

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

## Stress harness — empirical safety evidence

The protocol's safety claim is **"each user's joint outcome across
all four layers is positive with very high probability under
realistic stress."** That claim is empirically testable;
`lib/stressHarness.js` is the test.

```
npm run stress                          # all scenarios, n=200
npm run stress -- --n 1000              # 1000 runs per scenario
npm run stress -- --scenario CALM       # one scenario only
```

Or open the **Stress** tab in the running app — the same harness
runs in-browser and renders the joint-outcome distribution per
scenario.

Each session simulates a user who deposits $X, runs the easy-mode
auto-mint flow (allocate insurer stakes, buy 1.5× face reinsurance,
deposit principal as B-book stake, mint TT 1:1), then runs through
200 medium epochs of a stress scenario. Joint outcome = (final cash
margin + redeemable thread principal) − initial deposit. The
harness aggregates `P(joint outcome ≥ 0)` and the percentile
distribution across N seeded runs.

### Scenarios

| ID | Description |
| -- | -- |
| `CALM` | No event triggers, no redemption pressure. Tests baseline yield. |
| `SINGLE_EVENT` | One major event has ~30% trigger probability. Tests reinsurance recovery. |
| `CORRELATED_CRISIS` | Multiple correlated events (BTC + ETH + SPX + vol spike). Tests joint-stress survival. |
| `REDEMPTION_PRESSURE` | User redeems 25% of TT each cycle. Tests staged redemption mechanics. |

### Findings (default protocol calibration)

The harness has surfaced two structural calibration issues:

1. **`REINSURANCE_BASE_RATE = 0.010`** is per medium tick (≈ 365%
   annualised). Reinsurance premium cost dominates every scenario,
   driving joint outcome negative even in CALM where no events fire.
2. **`TBILL_RATE = 0.001`** is annualised (≈ 0.1% per year), so
   layer 1's contribution is negligible. The protocol's safety
   claim depends on layer 1 being a meaningful positive yield.

These are tuning targets for a future sprint — the harness's value
is producing this empirical evidence so the calibration question is
concrete rather than aspirational.

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
