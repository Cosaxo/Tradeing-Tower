# Trading Tower — LAP v2

ESMA-compliant **Leveraged Auction Protocol** simulator.

A clearinghouse that replaces the traditional orderbook with a *geodesic
leverage distribution* and *entropy-weighted yield* — minority liquidity
providers earn more when filling thin leverage buckets, stressed markets pay
insurance-pool depositors more, and position risk is settled in deterministic
tiers via an analytical Brownian-bridge barrier (Harrison 1985).

```
npm install
npm run dev   # → http://localhost:5173
```

## Architecture

### Epoch loop — three tiers

| Tier    | Period    | Responsibility                                                           |
| ------- | --------- | ------------------------------------------------------------------------ |
| Fast    | ~1 s      | price advance + deterministic barrier checks                             |
| Medium  | ~6 s      | auction, pool settlement, contract settlement, strip settlement, lending |
| Slow    | every 5×  | regime detection, insurance pool, cross-market correlation, metrics      |

Speed control (½×, 1×, 2×, 5×) scales both intervals proportionally.

### Core modules (`src/lib/`)

| Module            | Exports                                                          | Purpose                                                                                             |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `math.js`         | `sortino`, `calcCalmar`, `calcCorrelation`, `calcRealizedSigma`  | Pure statistics helpers. No state, no React.                                                        |
| `esma.js`         | `getEsmaCap`, `getEffectiveCap`                                  | ESMA Reg 2018/796 caps + vol-adaptive cap `min(ESMA, 1/(σ·√t·K))`.                                  |
| `priceModels.js`  | `priceStep`, `gbmStep*`                                          | GBM / Merton jump-diffusion / mean-revert / leverage-effect dispatcher.                             |
| `auction.js`      | `runAuction`, `geodesicWeight`, `calcEntropyWeights`             | **Core clearinghouse.** Geodesic distribution + KL-gradient meta-param adaptation.                  |
| `settlement.js`   | `geometricPnl`, `deterministicBarrierAdjustment`                 | Exact compounded P&L + Harrison (1985) barrier formula `P(τ ≤ T) = exp(-2ab/σ²)`.                   |
| `pool.js`         | `settleDominantPool`                                             | Risk-tiered SAFE/MEDIUM/RISKY cascade settlement with stability fee.                                |
| `regime.js`       | `REGIMES`, `detectRegime`                                        | Three-signal regime detection: trend, volRatio, autocorr.                                           |
| `npcs.js`         | `buildNpcs`, `updateNpcRegime`                                   | Five NPC profiles (Whale, Degen, Hedger, Bot, Bear) with regime-overlay adaptation.                 |
| `insurance.js`    | `settleInsurancePool`                                            | KL-divergence-driven counter-cyclical pool yield (1×–3×).                                           |
| `yieldModel.js`   | `updateYieldModel`, `calcStripPremium`                           | OU mean-reverting yield, Abramowitz-Stegun normal CDF, dynamic buffer rate.                         |
| `strips.js`       | `initStrip`, `settleStrips`                                      | Forward yield contracts with insurer book-size cap.                                                 |
| `contracts.js`    | `settleImbalanceContracts`, `settleEntropyContracts`             | LAP-native derivatives: imbalance + entropy contracts.                                              |
| `lending.js`      | `createOffer`, `matchBorrowRequest`, `settleLending`             | Position lending market (cheapest-first matching).                                                  |
| `credit.js`       | `assessCreditQualification`, `calcPairCreditEligibility`         | Skill-based leverage extension (Sortino/Calmar/WinRate/MaxDD + portfolio composition).              |
| `correlation.js`  | `calcCrossMarketCorrelations`, `portfolioCorrelationPenalty`     | Cross-pair correlation matrix.                                                                      |
| `stress.js`       | `calcStressThresholds`, `propagateShock`, `calcSystemSolvencyBuffer` | Shock propagation through correlated pairs, system-wide solvency.                                |
| `yieldRouter.js`  | `calcYieldRouterSuggestions`                                     | Ranked actionable yield opportunities per pair.                                                     |

### State (`src/state/`)

`initPairState(pairKey)` builds a full simulation state for one instrument:
prices, return history, NPC book, regime, yield model, insurance pool slice,
yield buffer, lending offers/borrows, contracts, strips, regime history.

### Hooks (`src/hooks/`)

- **`useEpochLoop`** — orchestrates the three-tier loop (accepts a `speed`
  multiplier).
- **`useToast`** — ephemeral notifications.
- **`useKeyboardShortcuts`** — declarative global key bindings (ignores input
  focus).
- **`usePersistentState`** — `useState` wrapper that hydrates from / syncs to
  `localStorage`.

### UI (`src/components/`)

| Component             | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `InstrumentSelector`  | Pick active pair from the 18-instrument list (with sparkline + %).   |
| `PriceChart`          | Price + regime band, tick grid, % return.                            |
| `LeverageCurve`       | Ideal (geodesic) vs actual fill curves per side.                     |
| `PlayerPanel`         | Sliders for leverage / margin / side, preset buttons, tip-tier editor. |
| `MetricsPanel`        | Equity curve + Sortino / Calmar / WinRate / MaxDD.                   |
| `NpcPanel`            | NPC book snapshot for the active pair.                               |
| `ContractDesk`        | Buy imbalance + entropy contracts.                                   |
| `StripDesk`           | Buy yield strips.                                                    |
| `PoolDesk`            | Deposit / withdraw from the insurance pool.                          |
| `LendingDesk`         | Post offer / borrow from the lending market.                         |
| `CreditDesk`          | Credit score breakdown + leverage extension.                         |
| `PortfolioStructurer` | Open / close multi-pair positions with eligibility checks.           |
| `CorrelationHeatmap`  | Cross-pair correlation matrix.                                       |
| `RegimeTimeline`      | Segmented timeline of regime transitions.                            |
| `StressPanel`         | System solvency + shock scenario.                                    |
| `TradeHistory`        | Ledger of closed trades with P&L.                                    |
| `LogicView`           | Scrollable epoch log with tag-colored lines.                         |
| `SpeedControl`        | ½× / 1× / 2× / 5× simulation tempo.                                  |

## Keyboard shortcuts

| Key          | Action         |
| ------------ | -------------- |
| `Space`      | Start / pause  |
| `1` – `9`    | Switch tab     |
| `+` / `-`    | Speed up / down |
| `r`          | Reset session  |

## Design principles

1. **Deterministic where it matters.** Settlement is 100% reproducible for the
   same price path. `Math.random()` only appears in `priceModels.js` (the GBM
   stepper); barrier checks use the Harrison (1985) analytical formula.
2. **Self-calibrating.** The geodesic distribution's meta-parameters
   (`muLow`, `alpha`, `sigmaMix`) adapt per epoch via KL-gradient descent on
   the actual-vs-ideal bucket fills — no hardcoded equilibrium.
3. **Counter-cyclical insurance yield.** KL divergence between ideal and
   actual fill distributions directly drives a 1×–3× multiplier on pool
   depositor payouts. Crises pay stakers more, which keeps capital locked.
4. **Entropy premium for minority fillers.** Thin leverage buckets receive
   disproportionate yield, which auto-routes liquidity where the book is
   under-supplied.
5. **No leaking abstractions.** Every lib module is a pure function of its
   inputs — zero module-level mutable state, zero implicit DOM references.
   All React hooks live in `src/hooks/`.

## Testing

```
npm run test          # run once
npm run test:watch    # watch mode
```

44 unit tests cover: math helpers, auction clearinghouse, ESMA caps,
deterministic settlement, lending market.

## Scripts

| Command              | What it does                                   |
| -------------------- | ---------------------------------------------- |
| `npm run dev`        | Vite dev server on :5173                       |
| `npm run build`      | Production build into `dist/`                  |
| `npm run preview`    | Serve the production build                     |
| `npm run lint`       | ESLint on the whole tree                       |
| `npm run format`     | Prettier on `src/**`                           |
| `npm run test`       | Vitest unit suite                              |
| `npm run test:watch` | Vitest in watch mode                           |

## State persistence

`usePersistentState` saves player config, open positions, equity history, and
closed trades to `localStorage` under `tt.*` keys. Press **`r`** (or the
reset button in the header) to wipe the session.

## License

MIT.
