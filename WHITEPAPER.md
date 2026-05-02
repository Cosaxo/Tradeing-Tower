# Trading Tower — Whitepaper

**Subject:** the Leveraged Auction Protocol (LAP v2) simulator implemented in
this repository.
**Audience:** engineers, quants, and protocol designers evaluating the model.
**Scope:** how the system actually works (as built), what it does well, where
it falls short, and the directions in which it could plausibly grow.

This document is descriptive, not promotional. It reads the codebase as the
specification — formulas, constants, and module names are taken from
`src/lib/*.js` and `src/constants/*.js` rather than from any aspirational
design document.

---

## 1. What Trading Tower is

Trading Tower is a **leveraged-trading clearinghouse engine** delivered
as a fully in-browser reference implementation. It replaces the
conventional limit-order book with an **auction over a parametric
leverage distribution**, layered with:

- ESMA-compliant per-asset leverage caps with a vol-adaptive override.
- A risk-tiered pool that settles winners and losers in cascading order.
- A standalone insurance market system (one market per protocol-defined
  event), three reinsurance products that sit behind it, and a fully
  collateralised stablecoin (Tower Tether, TT) minted against insurer
  allocations.
- An **OrderFlowAdapter** seam where real participant flow attaches —
  the engine ships with a NULL adapter and is otherwise free of synthetic
  counterparties.
- Regime detection, cross-pair correlation, paired-LAP delta-neutral
  positions, and a per-leg rental market.

The reference implementation is a single React + Vite app (no backend).
All state is in React state and `localStorage`; all math runs
client-side. There is no chain, no custody, no real money. The engine
itself is fintech-shaped — it is the participant feed, custody layer,
and authentication layer that the project does not yet provide and
must be added before the engine can be deployed against real flow.

---

## 2. Architecture at a glance

### 2.1 The three-tier epoch loop

Defined in `src/hooks/useEpochLoop.js`. Three nested cadences let
different concerns run on different time scales:

| Tier   | Period (1× speed) | Responsibilities                                                                                                       |
| ------ | ----------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Fast   | ~1 s              | Advance every pair's price one GBM/jump-diffusion step. Recompute realised σ. Run deterministic barrier checks.        |
| Medium | ~6 s              | Pull external bids from the order-flow adapter. Run the auction. Settle the dominant pool. Advance contracts, rentals, paired-LAP P&L. |
| Slow   | every 5th medium  | Detect regime. Update yield model. Recompute cross-pair correlations. Tick insurance markets and reinsurance.          |

Two additional **prime-stride** cadences run on top of the slow tier:

- `INSURANCE_EVERY = 23` — insurance markets settle on every 23rd medium
  tick, deliberately coprime with the slow tier so insurance yield
  arrives in chunky predictable steps rather than blurring into the
  analytics output.
- `REDEMPTION_EVERY = 31` — TT redemption cycles run on every 31st
  medium tick (also coprime with both 5 and 23). This makes redemption
  feel like a real bank window rather than a continuous drain.

Speed (½×, 1×, 2×, 5×) scales the wall-clock periods proportionally;
the relative ratios are preserved.

### 2.2 Module map

```
src/
├── lib/                          # pure logic — no React, no module-level state
│   ├── auction.js                # geodesic distribution + entropy weights + KL adapt
│   ├── settlement.js             # geometric P&L + Harrison (1985) barrier
│   ├── pool.js                   # SAFE/MEDIUM/RISKY cascade, hedgeChar correlation
│   ├── esma.js                   # ESMA caps + vol-adaptive cap min(ESMA, 1/(σ√t·K))
│   ├── priceModels.js            # GBM / Merton jump-diffusion / mean-revert dispatcher
│   ├── regime.js                 # 6 regime classifier (CALM…CRASH) + adj weights
│   ├── orderFlow.js              # OrderFlowAdapter contract (NULL, live feed, broker, replay)
│   ├── insuranceMarket.js        # two-sided binary insurance, sqrt-style premium
│   ├── insuranceEvents.js        # per-pair + macro event registry & detectors
│   ├── reinsurance.js            # three parallel reinsurance products (30/30/40 %)
│   ├── allocations.js            # user's percentage allocation across markets
│   ├── ltv.js                    # diversification-based LTV (HHI + Shannon + breadth)
│   ├── towerTether.js            # TT mint / queue / redemption / claw-back
│   ├── credit.js                 # solvency floor + structural pair eligibility
│   ├── pairedLap.js              # delta-neutral two-leg position primitive
│   ├── rentalMarket.js           # per-leg lease auction + tip stream
│   ├── correlation.js / stress.js / yieldModel.js / yieldRouter.js
│   └── conservation.js           # per-epoch identity check (money in ≥ money out)
├── hooks/useEpochLoop.js         # orchestrator
├── state/                        # initPairState, initInsuranceState
├── constants/                    # system tuning, asset registry, ESMA classes
└── components/                   # React UI panels (charts, desks, ledgers)
```

The cardinal architectural rule, enforced by convention: every file in
`src/lib/` is a pure function of its inputs. No `useState`, no
`Math.random()` outside `priceModels.js`, no DOM. The orchestration
hooks own the state and stitch pure modules together. This is the
single biggest reason the simulator is testable and reproducible.

---

## 3. The core auction

### 3.1 The geodesic leverage distribution

Implemented in `src/lib/auction.js`.

The "geodesic" distribution is a **bimodal log-normal mixture in
log-leverage space** with a Cornish-Fisher second-order skew/kurt
correction. Two modes — one low (conservative) and one high
(speculative) — capture the realistic preference structure of the
order book without requiring a hardcoded equilibrium.

For each leverage bucket `lev`, the unnormalised density is:

```
g(lev) = (1 − blend) · cf(d_low,  σ)     +     blend · α · cf(d_high, σ)

where cf(d, σ) is the standard normal density of the Cornish-Fisher z-score
      z_cf = z + (z² − 1)·sk/6 + (z³ − 3z)·ek/24
```

`muLow`, `muHigh`, `α`, and `sigmaMix` are **adaptive meta-parameters**.
They are not hand-tuned — each medium epoch, `adaptMetaParams` performs
KL-gradient descent against the actual fill distribution:

```
For each bucket i:
   p_i = ideal_i / Σ ideal           q_i = actual_i / Σ actual
   grad_i = p_i / max(ε, q_i)

Δμ_low = lr · Σ_{i<n/2}     grad_i · (i/n − 0.25)
Δα     = lr · Σ_{all i}     grad_i · (i/n − 0.50) · 0.1
```

Smile parameters (`sk`, `ek`) are estimated from the live bid sample
each tick and EMA-blended with the prior (`α = 0.3`). The result is a
distribution that **shapes itself to whatever the order flow is doing**
rather than asserting what the order flow ought to look like.

### 3.2 Entropy-weighted minority yield

`calcEntropyWeights` measures, per leverage bucket, how under-supplied
the actual fills are versus the ideal density:

```
KL_i  = p_i · log(p_i / q_i)
w_i   = 1 + β · (KL_i / max(KL))      with β = ENTROPY_BETA = 0.3
```

Normalised weights become a **multiplier on the per-bid tip**, so a
participant who fills a thin bucket earns a disproportionate share of
the tip stream. Smoothing is applied across epochs (`prev × 0.7 +
new × 0.3`) so the multiplier doesn't oscillate.

Economically, this means: when no one wants to take 8× short on
Bitcoin, anyone who does is paid extra to do it — and the extra comes
from the dominant side, not from the protocol's reserves.

### 3.3 Matching

`matchBids` is a greedy descending-leverage match between the long and
short books. When the leverage offers don't line up exactly, the
algorithm cascades down a sub-unit ladder (`SUB_UNIT_STEPS = [0.75,
0.5, 0.25]`) until a fillable fraction is found, with a hard floor of
`0.5×`. Below that the bid is dropped this epoch rather than forced.

If either side of the book is empty the auction short-circuits to a
well-formed zero result so that downstream consumers (entropy
contracts, strips, secondary markets) never see undefined state.

### 3.4 Caps: ESMA + vol-adaptive

`getEffectiveCap` (in `src/lib/esma.js`) returns the **min** of:

```
ESMA cap            (e.g. 2× crypto, 30× FX-major, 5× single-stock)
Vol-adaptive cap    1 / (σ_realized · √dt · K)   with K = INSURANCE_K = 3
```

The vol cap is always the binding constraint when realised vol spikes;
the regulatory cap binds in calm regimes. Each instrument's
`bindingConstraint` flag (`"VOL"` vs `"ESMA"`) is exposed in the UI so
the user can see what's actually limiting them.

---

## 4. Settlement: deterministic, geometric, tiered

### 4.1 Geometric P&L

`geometricPnl(margin, leverage, p_old, p_new, side)` returns

```
PnL = margin · leverage · (exp(direction · log(p_new/p_old)) − 1)
```

This is **exact compounding**, not the linear approximation. Holding
1×, 2×, 4× across the same price path produces results that compound
correctly relative to one another, which matters for paired LAPs (see
§7) and for any backtest of long horizons.

### 4.2 Brownian-bridge barrier

The Harrison (1985) analytical formula

```
P(τ ≤ T) = exp(−2ab / σ²)
```

estimates the probability that a Brownian bridge between `log(p_old)`
and `log(p_new)`, with endpoint-anchored noise, **touches the
liquidation barrier**. `a` and `b` are the signed log-distances from
the two endpoints to the barrier. The expected loss given a touch is
applied to margin deterministically.

**Why this matters:** mid-epoch wicks frequently destroy positions that
look safe at start-of-epoch and end-of-epoch prices. The bridge
estimate captures that risk without simulating intra-tick paths,
preserving reproducibility.

### 4.3 Three-tier cascade pool

`settleDominantPool` (in `src/lib/pool.js`) sorts every active position
by a `riskScore = leverage · σ · margin · corrPenalty` and slices the
sorted set into:

- **SAFE** — bottom 40 %
- **MEDIUM** — middle 30 %
- **RISKY** — top 30 %

Within each tier, the tier's aggregate P&L is redistributed by a
**safety-inverse share**:

```
adjShare_i = (m_i · 1/riskScore_i) / Σ (m_j · 1/riskScore_j)
```

So safer participants take a smaller share of a losing tier and a
larger share of a winning one. RISKY positions additionally pay a
`stabilityFee = 0.2 %` of their post-settlement margin into the pool
each tick.

The correlation penalty itself is **hedge-character-aware**:

```
corrPenalty_i = max(0.75, 1 + (1/n) · Σ ρ_{i,j} · (1 − h_i · h_j) · 0.5)
```

Two equity longs (both `hedgeChar < 0`) get the full penalty. Gold
(`hedgeChar 0.6`) against SPX (`hedgeChar -0.3`) gets a discount — the
math correctly rewards genuinely diversifying combinations rather than
just counting position labels.

### 4.4 Tip escrow

`escrowTips` runs **before** the cascade and sets aside the matched
tips in a separate ledger. This guarantees minority-yield payouts
independent of cascade outcomes — a thin-bucket filler still gets paid
even if the dominant pool is collapsing.

---

## 5. Insurance, reinsurance, and Tower Tether

### 5.1 Insurance markets

`src/lib/insuranceMarket.js`. Each protocol-defined event (e.g.
"BTC drops > 20 % in a week", "≥ 3 pairs in CRASH simultaneously",
"system solvency < 5 %") gets its own two-sided market:

- **Insurer side** posts capital. Earns a per-tick premium stream
  proportional to its share of `insurerCapital`. Pays out on trigger.
- **Insured side** buys face coverage. Pays per-tick premium
  `face × rate`. Receives min(face, share × insurerCapital) on trigger.

The premium rate is supply-and-demand, on a square-root spread:

```
rate = clamp( BASE · (totalCoverage / insurerCapital)^0.5 ,
              MIN_PREMIUM_RATE,
              MAX_PREMIUM_RATE )
```

At parity rate = BASE; 2× demand → BASE × √2 ≈ 1.41 × BASE; 4× demand
→ 2 × BASE.

### 5.2 Reinsurance (three products, in parallel)

`src/lib/reinsurance.js`. There are **exactly three** reinsurance
products, declared at module load:

| Product | Coverage fraction |
| ------- | ----------------- |
| REINS-1 | 30 %              |
| REINS-2 | 30 %              |
| REINS-3 | 40 %              |

Buyers of all three are 100 % reinsured against any insurance loss
they take as sellers. Same two-sided premium structure as primary
insurance, but at twice the base rate (`0.010` vs `0.005`) and with a
**200-epoch lockup** on seller capital — reinsurance is the system's
last line of defence and must remain reliably present.

### 5.3 Tower Tether (TT)

`src/lib/towerTether.js`. TT is a fully-collateralised stablecoin
minted against the user's **insurance allocations** (insurer-side
stake), gated by an LTV that rewards diversification (§5.4).

Mint capacity:

```
capacity = totalStake · LTV · MINT_COEFFICIENT
                              (= 0.5)
```

The mint is gated by `MINT_LTV_GATE = 0.6`: a concentrated allocation
yields LTV at the floor (0.30) and cannot mint at all. At the moment
of mint, the protocol auto-purchases reinsurance face equal to
`mintAmount × 1.5 / 3` on each of the three products — the **1.5×
rule** that ensures the user's potential insurance liability is always
≤ 150 % of their reinsurance coverage.

Redemption runs on a **prime-stride cycle** (every 31 medium ticks,
~monthly in sim-days). Each cycle drains up to
`STANDARD_REDEMPTION_CAP_PCT = 10 %` of total supply for free; anyone
who needs to skip the queue pays `EXPRESS_PENALTY_RATE = 5 %`,
forfeited to the insurance pool.

When a redemption clears, **every current minter loses pro-rata** —
this is the explicit collective haircut that defines a properly
collateralised stablecoin. If a minter's allocation collapses
mid-cycle (LAP loss propagating through their insurer stake),
`applySolvencyCheck` claws TT back from the wallet and any uncovered
remainder becomes debt.

### 5.4 Allocation-based LTV

`src/lib/ltv.js`. LTV is a five-term composite over the user's
insurer-side allocation vector:

```
LTV = floor + concentration + diversity + breadth − maxWeightPenalty

where:
  floor              = 0.30
  concentration      = 0.25 · (1 − HHI)            HHI on stake share
  diversity          = 0.25 · ShannonNorm
  breadth            = 0.20 · min(1, n/N)          n active / N registered
  maxWeightPenalty   = 0.20 · max(0, max_w − 0.5)/0.5
  ceiling            = 1.00
```

A perfectly equal split across every market hits the ceiling. A single
giant market hits the floor and triggers the maxWeight penalty. The
weights sum to `0.70`, so `floor + sum_of_terms = ceiling` is exactly
achievable.

This is **the** axiomatic statement of risk in the system: how much
credit you get is entirely a function of how spread-out your
insurance-market exposure is. Concentration is repriced as risk
without invoking any external oracle.

---

## 6. Capital roles and the conservation identity

A single dollar in this system can simultaneously:

- Trade as LAP margin.
- Sit as insurer-side capital in N markets.
- Back TT mint capacity.
- Be auto-protected by reinsurance face the protocol bought on the
  user's behalf.

The `capitalTags` module attaches role tags to capital rather than
moving the capital around. The `roleLedger` then attributes
per-epoch P&L to each role so the user can see where the money
actually came from.

Per-epoch the `conservation.js` identity must hold:

```
totalIn (premiums + stability fees + rent)
   ≥
totalOut (claims + depositor distributions) + tipsEscrowed
```

If any tick violates the identity (with `ε = 0.01`), the violation is
flagged in the log stream. This is a self-check, not a circuit-breaker
— but it is a strong constraint on any future change to the settlement
flow.

---

## 7. Paired LAPs and the rental market

`src/lib/pairedLap.js` introduces a delta-neutral primitive: open both
the long and short leg of one pair at the same leverage in a single
atomic position. Net price exposure is structurally zero; P&L comes
from positive **gamma** (the convexity of holding both sides) plus the
auction tip income from filling both sides of every match.

`src/lib/rentalMarket.js` then lets the owner publish either leg as a
**rental offer**: a renter posts collateral (`RENTAL_MARGIN_FRACTION =
0.20` of leg notional) and pays a per-tick tip rate to the owner. The
renter takes the leg's directional P&L; the owner keeps the tip stream
and reclaims the leg cleanly on expiry, on default, or on manual
termination.

The match is a per-pair greedy clearing: lowest-floor offers paired
against highest-bid bids, clearing at the **owner's floor** (renter
gets the discount). Defaulting a rental returns the leg to the owner
and the owner keeps the accrued tips; the renter loses their posted
margin.

Effect: a participant who would otherwise be flat can monetize
volatility and order flow by holding the convex paired structure and
renting out directional exposure. This is one of the more interesting
secondary mechanisms — it's also one of the most under-used parts of
the UI surface.

---

## 8. Counterparty flow and regime detection

### 8.1 The OrderFlowAdapter

`src/lib/orderFlow.js` defines the seam where external participant flow
enters the auction. Earlier iterations populated the book with five
hard-coded synthetic counterparties; that path is gone. The auction now
asks an injected adapter for bids each medium tick:

```js
adapter.getBids({ pairKey, currentEpoch, regime, realizedSigma, cap })
  // → Array<{ id, strategy, base_margin, max_lev, tip_tiers, ... }>

adapter.getPoolUsers(ctx)   // optional — for participants that hold
                            //            positions, not just submit bids
```

Three concrete adapter shapes are anticipated:

- **Live participant feed.** Authenticated traders connect to a backend;
  the backend buffers their bids per epoch and exposes them via the
  adapter. This is the production target.
- **Broker / exchange connector.** A translation layer that maps an
  external book (e.g. Binance, Hyperliquid, IBKR) into the LAP bid
  shape. Useful for market-making the protocol against an existing
  venue's flow.
- **Historical-tape replay.** Recorded bids from a CSV/JSON file,
  emitted on a synchronised clock. Required for reproducible
  backtesting and for any rigorous analysis of mechanism behaviour.

The repo ships with `NULL_ORDER_FLOW_ADAPTER`, which returns no flow.
With the NULL adapter the auction's empty-book short-circuit (see §3.3)
yields a well-formed zero result and the rest of the loop proceeds —
the system is fully functional with no external connection, just
quiet.

### 8.2 Six regimes

`src/lib/regime.js` classifies the 20-epoch return history into one of
six regimes from three signals:

```
trend     = mean(sign(r))            over 20 epochs
volRatio  = σ_5 / σ_20                short / long realised vol
autocorr  = lag-1 autocorrelation     (mean-revert detector)
```

Decision tree:

```
volRatio > 2.0  AND  trend < −0.3        → CRASH
volRatio > 1.5                           → HIGH_VOL
trend > 0.4                              → TRENDING_UP
trend < −0.4                             → TRENDING_DN
autocorr < −0.3                          → MEAN_REVERT
otherwise                                → CALM
```

Each regime carries `sigmaAdj` and `muAdj` that nudge the geodesic
distribution. The classifier output is also part of the adapter
context, so any external flow source can condition its bidding on the
current regime. The closed loop is: realised returns → regime →
distribution + adapter bids → auction outcomes → new returns.

---

## 9. What's good

### 9.1 The core mechanism is mathematically self-consistent

The geodesic distribution + KL-adapt + entropy weights form a tight
loop. Tips are paid only by the dominant side; the dominant side gets
a discount when the book is balanced; minority fillers get paid extra
when it isn't; the meta-parameters move whenever ideal and actual
diverge. There is no hidden equilibrium — equilibrium is whatever the
flow makes it.

### 9.2 Reproducibility is taken seriously

Settlement is bit-for-bit deterministic. `Math.random()` lives only in
`priceModels.js`. The barrier check is analytical, not Monte Carlo.
The conservation identity is checked every epoch. The 44-test Vitest
suite covers every settlement path the README claims it does. Anyone
can take a price tape and replay the entire P&L, fee, and pool flow
from it without re-running the GBM stepper.

### 9.3 Risk pricing is endogenous, not parametric

ESMA caps, vol-adaptive caps, hedge-character-aware correlation
penalties, allocation-based LTV — none of these depend on a price
oracle, a governance vote, or a magic number. They are computed from
state. The only externally injected numbers are the asset-class
constants (which are quotes from real EU regulation) and the tuning
constants in `src/constants/system.js`.

### 9.4 The capital model is unusually clean

A single dollar earns yield as insurer capital, backs LAP credit, and
collateralises TT mint **simultaneously**, via tags rather than
transfers. The `roleLedger` makes this attribution legible. Most
on-chain protocols invent multiple wrapper tokens to express what
this system expresses with one number and a tag dictionary.

### 9.5 The simulator is a serious teaching artifact

Every concept in the model has a UI panel that lets you poke it:
`LeverageCurve` shows the geodesic vs the actuals, `FeeFlow` shows
where the dollars went this epoch, `RegimeTimeline` shows the
classifier history, `StressPanel` lets you run a propagated shock,
`RoleLedger` shows per-role attribution. There is no part of the
mechanism that is invisible to the user.

### 9.6 Governance surface is small

There is no protocol committee, no upgradeable contract, no
emergency-pause role. The only "governance" is the ability to override
the geodesic learning rate. Everything else is parametric and pure.

---

## 10. What's bad

### 10.1 It's a clearinghouse engine, not a deployed product

The mechanism is implemented; the production envelope around it is
not. There is no settlement layer, no custody, no chain, no oracle,
no authentication. Every "mint", "withdrawal", and "redemption" is a
state mutation in React. The full set of integration concerns — MEV,
oracle delay, re-org safety, gas, off-chain coordination, KYC, custody
controls — is absent. The repositioning to remove synthetic NPCs makes
this gap honest rather than papered over: the engine is now visibly
inert without an OrderFlowAdapter wired in.

### 10.2 No bundled order-flow source

Removing the synthetic NPCs leaves the engine with no counterparty
flow out of the box. That is intentional — the legacy NPCs let casual
runs *look* like a working market while doing nothing of forensic
value — but it does mean the project now requires either a bundled
historical-tape replay or a connectable live-feed adapter before any
quantitative claim about mechanism behaviour can be made. Until one
of those exists, the auction's adaptive parameters can be reasoned
about analytically but not empirically.

### 10.3 The regime classifier is brittle

Three thresholds (`volRatio 2.0`, `volRatio 1.5`, `|trend| 0.4`) over
a 20-epoch window will misclassify any market that doesn't look
exactly like the GBM/jump-diffusion price models that feed it. The
regime is then a hard input to the geodesic distribution and to any
adapter that conditions on it. A misclassified regime cascades into
wrong tip ladders, wrong leverage caps, and wrong ideal
distributions. The classifier needs either a probabilistic output, a
hidden-Markov backbone, or both.

### 10.4 Reinsurance is conceptually right, structurally fragile

The 30/30/40 split is hard-coded. The lockup is a single constant
(200 epochs). There is no mechanism by which seller capital
*expands* in response to repeated triggers — if all three pots
exhaust within a few ticks, the 1.5× rule on TT minting is the only
remaining safety, and that is enforced only at mint time, not
re-checked when reinsurance pots deplete. A long enough crisis
breaks the chain.

### 10.5 The cascade pool's tier boundaries are static

40 / 30 / 30 is a clean split for an explainer slide and a defensible
default, but the boundaries are constants. They don't move with the
size of the book, the dominant regime, or the realised σ. In a
regime where 80 % of the book is risky, the SAFE tier becomes a
fictional construct; in a regime where the whole book is genuinely
safe, the RISKY tier exists only to collect the stability fee from
people who don't deserve to pay it.

### 10.6 The conservation check is necessary but weak

It checks that one tick's outflows don't exceed that tick's inflows
plus pool deposits. It does not check **multi-tick** invariants — for
instance, that the cumulative payout to any participant across an
arbitrary horizon respects the tip-ledger split. The lack of a stronger
invariant means the system is auditable per-tick but not provably
sound across longer windows.

### 10.7 LTV is sensitive to the registry cardinality

The `breadth` term divides by `markets.length`. The standard event
registry has eight events. Allocating to all eight gives breadth = 1.
If a future version adds a ninth event, every existing user's LTV
silently drops. This is a structural footgun — the term should be
either log-scaled or normalised against an immutable reference set.

### 10.8 The codebase carries early-iteration scars

`calcPoolLtv` has a deprecated implementation that returns the floor
and exists purely so legacy call sites don't crash. `getEntropyMultForUser`
produces identical multipliers for both legs of a match (`entMultL`
and `entMultS` are computed independently but always equal). The
auction's smile-parameter blend ratio is a magic 0.3. None of these
are blockers, but they are evidence that the code grew faster than it
was hardened, and a careful re-pass would simplify several modules.

### 10.9 The UI is dense

Eight tabs, each with multiple desks, each with its own set of inputs.
A new user landing on the app sees a wall of metrics with no obvious
entry point. The `Tutorial` and `GettingStarted` components help, but
the cognitive load of the simulator is closer to a Bloomberg terminal
than to a teaching demo.

### 10.10 No persistence beyond `localStorage`

Wipe the browser, lose the run. No multi-session experiments, no
shareable scenarios, no replay export. The simulator is excellent for
exploring its own mechanism in real time and useless for any kind of
collaborative experiment.

---

## 11. What it has potential to be

### 11.1 An on-chain leveraged-trading venue

The mechanism is genuinely novel and deserves a real implementation.
The core auction (geodesic + KL-adapt + entropy) compiles down to a
single per-epoch state transition that is fully on-chain-feasible:
each epoch, the protocol publishes the bucket distribution; users
post bids; the contract clears them deterministically; tips,
liquidations, and pool settlement follow analytically. The barrier
check is a closed-form expression — no oracle round-trips.

The hardest part of the on-chain version is **price input**, not
mechanism. The current simulator uses a private GBM stepper. A
production version needs a TWAP plus a Pyth/Chainlink fallback plus
some governance over the dispute window. The mechanism itself is
ready.

### 11.2 A genuine alternative to the funding-rate perpetual

Today's perp protocols (dYdX, Hyperliquid, Drift) all converge on the
same basic shape: limit-order book + mark price + funding rate. LAP
v2 is a structurally different bet: **clear the book by pricing
leverage instead of by pricing time**. The funding rate is replaced
by a tip rate that flows from the dominant side to the minority side
at the moment of match. This is closer to how a real market-maker
prices order flow than the funding-rate construction is.

If this turned out to clear at materially tighter spreads under realistic
flow, that would be a real result. The simulator is currently the only
way to test that hypothesis.

### 11.3 A modular insurance-backed stablecoin design

Tower Tether's collateralisation model — mint against
**diversification of insurance-market participation**, gated by
allocation-LTV, hedged by auto-purchased reinsurance — is unusual
and probably the right shape for a fully-collateralised, decentralised
stablecoin. It is the only design I am aware of where the act of
minting forces a measurable improvement in the system's risk profile
(by demanding diversification) rather than degrading it.

The 1.5× rule is a clean structural invariant. The redemption
prime-stride is a clean liquidity primitive. These should be
extracted, named, and proposed independently of the rest of the
system.

### 11.4 A research platform for adaptive market microstructure

Even setting aside any production ambition, this is one of the
cleanest sandboxes I've seen for testing ideas like:

- KL-gradient adaptation of a parametric distribution to live order flow.
- Counter-cyclical insurance yield driven by ideal-vs-actual divergence.
- Hedge-character-aware correlation in cascade settlement.
- Risk-tiered settlement with safety-inverse intra-tier shares.

A careful pass to add price-tape import, deterministic seed control,
a CSV/JSON export of every per-epoch state, and a small library of
reference adapter implementations (replay, deterministic-bot, broker
shim) would turn this from an interactive demo into a reproducible
research platform that other people could publish results from.

### 11.5 A pedagogical anchor for derivatives engineering

The simulator cleanly demonstrates: ESMA leverage caps, vol-adaptive
extensions, geometric P&L, Brownian-bridge first-passage probability,
KL divergence as a yield signal, OU mean-reversion in yield models,
HHI/Shannon as collateralisation inputs, fully-collateralised
stablecoin design, and event-triggered insurance markets — all in one
coherent system. With minor tightening of the UI and a documented
walkthrough, it could become the canonical "modern derivatives
mechanism" teaching artifact, in a way that no textbook currently is.

### 11.6 An adversarial testbed before any of the above

Before any of §11.1–§11.4 is taken seriously, the engine should gain
an **adversarial bot framework**: a way to plug arbitrary strategies
into the OrderFlowAdapter and let them compete at high speed. The
protocol's properties are only as strong as their worst-case
adversary; with no built-in counterparty flow now that NPCs are
removed, this is the obvious next priority. Any claim above
(positive or negative) needs the empirical backing such a framework
would produce.

---

## 12. Closing assessment

Trading Tower implements a coherent and unusually well-factored
clearinghouse engine. The mechanism is interesting on the merits and
the implementation is honest about its purity boundaries. With the
synthetic NPC layer removed, the project is now visibly an engine in
search of real participant flow — exactly the right framing for a
serious fintech product, and exactly the right trigger for the next
round of work.

The right next steps, in order of impact:

1. **Order-flow adapter implementations.** A historical-tape replay
   first (deterministic, reproducible, sufficient for backtesting).
   Then a broker/exchange connector for live market-making. Finally
   a backend with authenticated participants for production.
2. **Backend layer.** Node service for sessioned users, persistent
   storage in a real database, push-based bid submission, server-side
   custody bookkeeping. Replace `localStorage` with a real source of
   truth.
3. Adversarial bot framework on top of the adapter contract.
4. Hidden-Markov or probabilistic regime classifier.
5. Dynamic cascade-tier boundaries.
6. Cardinality-stable LTV breadth term.
7. Multi-tick conservation invariants.
8. On-chain proof-of-concept of the auction core, once an adversarial
   testbed has produced data worth defending.

The project is a long way from being a deployed protocol, but the gap
is specific and addressable, and the adapter seam makes each gap
attackable independently. The mechanism design is the asset; the
engine is the working artifact that earned the right to take that
mechanism seriously.
