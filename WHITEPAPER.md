# Trading Tower

### A Four-Layer Thread Stablecoin with Joint-Outcome Safety

**Working draft · v0.1**

---

## Abstract

Trading Tower is a financial protocol in which one dollar of user
deposit simultaneously plays four roles — risk-free principal,
insurance-seller stake, B-book pool stake, and stablecoin face — via
a single mint operation that creates a *thread*. Damage to any role
propagates through all four in lockstep; growth fattens the
non-monetary roles to build a buffer above the stablecoin face. The
protocol's safety claim is not that any individual role never loses
money — it is that **each user's joint outcome across all four roles
is positive with very high probability under realistic stress**. We
verify this empirically with a deterministic Monte Carlo harness
across seven stress scenarios at n=200 each: P(joint outcome ≥ 0) =
100% in 6 of 7 scenarios and 96% in the worst (a fat-tailed B-book
catastrophe), with a mean annualised yield of ≈8.5% in calm
conditions. We describe the architecture, the empirical safety
analysis, the calibration story, and a forward-looking section on
extensions enabled by more sophisticated logic.

---

## 1. Introduction

### 1.1 The retail yield problem

Retail savers face a binary choice. On one side: high-yield savings
accounts and short-duration Treasury products that pay near the
risk-free rate (≈4% annual at the time of writing) with effectively
zero blow-up risk. On the other: leveraged DeFi protocols, perpetual
futures, structured products, and carry strategies that can pay
double-digit yields but periodically experience drawdowns of 30–95%
when the regime they're calibrated against shifts.

The structural reason is that most retail yield products *stack
risk*: leverage on top of an underlying, perpetuals on top of a
stablecoin, etc. Each layer adds yield but also adds correlated
exposure to the same underlying. When the underlying moves, all
layers move together.

### 1.2 The Trading Tower thesis

The protocol's thesis is that capital efficiency can be improved
substantially without stacking risk, by stacking *uncorrelated yield
sources on the same capital*. Four roles, each producing yield from
a different mechanism:

| Layer | Yield source | Correlation to layer 1 |
| :--: | :-- | :-- |
| 1 | T-bill principal | — (baseline) |
| 2 | Insurance premium income from event-market sellers | low (idiosyncratic event risk) |
| 3 | B-book pool yield from underwriting unprofitable retail flow | low (cross-asset, cross-direction) |
| 4 | TT optionality (stablecoin face usable as payment) | — (no yield, optionality) |

The same dollar fills all four roles simultaneously. There is no
duplication: the conservation invariants (Section 6) guarantee
every dollar has a single counterparty at every moment. The
*efficiency* gain comes from the mathematical fact that, when yield
sources are sufficiently uncorrelated, their joint distribution is
much tighter than any individual layer. A user can realistically
earn 4% (T-bill) + 3% (insurance net) + 2% (B-book net) ≈ 9%
annualised with downside protection on each stream.

### 1.3 Result

The protocol has been implemented as a working simulator with 364
unit + integration tests, a Monte Carlo stress harness, and
multi-user trading via `BroadcastChannel`. Empirical results across
seven scenarios at n=200:

| Scenario | P(joint ≥ 0) | Mean | Worst |
| :-- | :--: | :--: | :--: |
| Calm market | 100% | +4.5% | +4.5% |
| Single insurance event triggers (~30% chance per run) | 100% | +4.5% | +4.3% |
| Correlated multi-pair crisis | 100% | +4.4% | +3.9% |
| Sustained TT redemption pressure | 100% | +4.5% | +4.5% |
| Layer-3 zero-mean volatility | 100% | +7.3% | +1.5% |
| Layer-3 sustained losing streak | 100% | +2.2% | +1.5% |
| Layer-3 fat-tail catastrophe | 96% | +7.0% | −4.0% |

All values over 200 simulated days. Mean annualised yield ≈ 8.5%
across the original four scenarios; uplifted in B-book stress
scenarios because growth on the user's stake is asymmetric to
loss-with-reinsurance.

---

## 2. The Four-Layer Thread

### 2.1 Definition

A *thread* is a record of the form

$$
T = (\text{owner}, \, P, \, F, \, \mathbf{w}, \, \tau_0)
$$

where
- $P \in \mathbb{R}_{\geq 0}$ is the *principal* (layer 1, T-bill),
- $F \in \mathbb{R}_{\geq 0}$ is the *outstanding TT face* (layer 4),
- $\mathbf{w} = (w_1, \dots, w_n)$ are the *insurance fill weights* across markets, with $\sum w_i \approx 1$ (layer 2),
- $\tau_0$ is the creation epoch.

The user's *threadDerivedStake* in the B-book pool is, by
construction, equal to $P$ (layer 3). The four layers are
constrained to stay in lockstep.

### 2.2 Mint

To open a thread of size $X$, the user must have $X$ of free margin
(margin not already tagged to another role). The protocol then
atomically:

1. Tags $X$ on the user's margin as `threadStake` (so the same
   dollars cannot back another role).
2. For each insurance market $i$ with $w_i > 0$, posts $X \cdot w_i$
   as the user's insurer stake.
3. Auto-buys reinsurance face $X \cdot c_k$ on each reinsurance
   product $k$, where $c_k$ is the product's `coverageFraction`. The
   total face equals $X \cdot \sum c_k = X$ (the minimum
   full-coverage configuration).
4. Auto-buys B-book reinsurance face equal to $X \cdot 0.30$.
5. Increments the user's `threadDerivedStake` in the B-book pool by
   $X$.
6. Mints $X$ TT into the user's wallet (so $F = X$ at $\tau_0$).

The mint is 1:1 against free margin; there is no LTV gate or
coefficient. The gating constraint is whether the user has $X$ of
free margin to commit to all four layers at once.

### 2.3 Damage and growth invariants

When any layer of a thread experiences a loss of $L$ (e.g., an
insurance event triggers and the user's insurer stake pays out):

$$
P \rightarrow P - \min(P, L) \quad\text{and}\quad F \rightarrow \min(F, P')
$$

where $P'$ is the post-update principal. All four layers shrink
together — the layer-2 stake reduction in each affected market is
$L \cdot w_i$, the layer-3 reduction is $L$, and the layer-4 face
reduces only when $P' < F$ (preserving the buffer, see §2.4).

When any layer experiences a gain of $G$:

$$
P \rightarrow P + G \quad\text{but}\quad F \rightarrow F
$$

Layer-1, 2, 3 fatten by $G$; layer 4 (TT face) is intentionally
non-elastic. Gains accumulate as a *buffer* $P - F \geq 0$, which
absorbs subsequent damage before TT face starts shrinking.

### 2.4 Buffer asymmetry

The asymmetry $G \to P, F$ unchanged versus $L \to P, F$ both
shrink (when $L$ exceeds the buffer) is a deliberate design choice
that gives the protocol a preferred direction:

- TT supply only expands on a deliberate mint event, never from
  passive yield. This keeps the stablecoin's monetary base
  predictable.
- Accumulated yield is *first-loss capital* — it absorbs damage
  before the user's redeemable face value is at risk.

This asymmetry is the structural reason the joint outcome
distribution skews positive even under zero-mean B-book P&L noise:
gains compound on the principal while losses are absorbed by
reinsurance into the wallet, and the buffer captures the
difference.

### 2.5 Why this isn't bad rehypothecation

The phrase "one dollar in four roles" might evoke shadow-banking
re-pledging where the same collateral backs multiple uncorrelated
claims that all default in stress. Trading Tower is structurally
different:

- Conservation invariants (§6.1) are enforced and tested. Every
  cash flow has a named counterparty.
- The four roles are *yield streams*, not *claims*. A loss in any
  role mechanically depletes the principal that funds them all,
  rather than four parties each suing for the same dollar.
- The lockstep damage propagation makes the linkage explicit: the
  protocol cannot silently double-pledge.
- Reinsurance hedges the two riskiest layers (2 and 3), so realised
  losses on those layers are reimbursed back into the wallet.

---

## 3. Layered Risk Architecture

### 3.1 Insurance markets

Per protocol-defined event $e_i$ (e.g., "BTC drops 20% in a week"),
a two-sided market exists with state

$$
\mathcal{M}_i = (\text{insurer positions}, \text{coverage}, \text{premium rate})
$$

Insurers post capital that pays out on trigger; insureds buy
coverage face and pay per-tick premium. The premium rate is

$$
r_i = \text{clamp}\Bigl( r_0 \cdot \sqrt{\frac{C_i}{S_i}}, \; r_0 \cdot 0.01, \; r_0 \cdot 10 \Bigr)
$$

where $C_i$ is total coverage demanded, $S_i$ is insurer capital,
and $r_0$ is `BASE_PREMIUM_RATE`. The square-root sensitivity
self-moderates: doubling demand only multiplies the rate by
$\sqrt{2}$. The clamp prevents pathological behaviour at extreme
ratios.

On trigger, payouts are pro-rata to coverage:

$$
\text{payout}_j = f_j \cdot \min(1, S_i / C_i)
$$

and insurer losses are pro-rata to stake. The market resets
post-trigger.

### 3.2 Reinsurance

Three parallel reinsurance products $\{R_k\}_{k=1}^{3}$ with
coverage fractions $c_k = (0.30, 0.30, 0.40)$, $\sum c_k = 1$.
Each reinsurance product covers a fraction of the insurance
seller's claim losses:

$$
\text{payout}_{R_k}(\text{user}) = \min\bigl( \text{face}_{R_k}, c_k \cdot L_{\text{insurance}}(\text{user}) \bigr)
$$

A buyer holding face on all three with $\sum c_k = 1$ is fully
covered (up to face) on any single insurance loss. Sellers have a
200-tick lockup matching the system's defence-of-last-resort role.

### 3.3 B-book reinsurance pool

A separate single-product reinsurance covers layer-3 drawdowns
(retail-trader counterparty losses on the B-book pool). It uses a
*high-water-mark stop-loss* on the user's cumulative B-book P&L:

$$
\text{drawdown}_t = \max_{s \leq t} \Bigl( \sum_{u \leq s} \pi_u \Bigr) \;-\; \sum_{u \leq t} \pi_u
$$

where $\pi_u$ is the user's per-tick B-book P&L (signed). When
drawdown exceeds the attachment threshold (10% of face), the
product pays out the layer between attachment and exhaustion, up
to face value. New peaks reset the drawdown cycle.

This design ensures the layer-3 hedge fires only on B-book P&L
losses, not on insurance-driven thread damage (which has its own
reinsurance) or T-bill growth.

### 3.4 The epoch-separation invariant

Insurance settlement and LAP/B-book settlement run on coprime
strides — `INSURANCE_STRIDE = 2` for insurance, the off-stride for
LAP. The two damage sources never coincide on the same medium
tick. Formally, for any thread $T$ and tick $t$,

$$
|\Delta P_{\text{insurance}}(t)| \cdot |\Delta P_{\text{LAP}}(t)| = 0
$$

i.e., at least one is zero. This prevents over-debit when both
settlements would compute pro-rata shares against the same
pre-update principal.

---

## 4. Auto-Mint and the Tier Ladder

### 4.1 Tier ladder

Capital climbs through four tiers, each adding an uncorrelated
yield source:

| Tier | Adds | Gate to enter |
| :--: | :-- | :-- |
| 1 | T-bill principal | none |
| 2 | Insurance-seller stake across event markets | none |
| 3 | LAP active-trade access | ≥3 markets allocated; max 50% in any one; reinsurance bought |
| 4 | TT mint (full thread) | layer-3 role is *passive* B-book stake, not active LAP |

Tier 3 enforces *diversified, hedged* allocation as a hard gate
(`evaluateTier3Gate` in `lib/ltv.js`). Tier 4 is per-thread
mutually exclusive with active LAP trading: capital you've minted
into TT is locked as a passive B-book underwriter; capital you
haven't minted is free to actively trade.

### 4.2 Easy mode and minting irreversibility

The retail user interacts with one button: *Convert $X to TT*.
This auto-runs the entire ladder in the safe configuration —
allocate evenly across reinsurance-covered markets, buy
reinsurance, deposit B-book stake, mint TT.

Minting is *deliberately reversal-resistant*:

- Standard redemption is capped at 10% of TT supply per
  redemption cycle (every ≈31 ticks ≈ monthly in sim time).
- Express redemption bypasses the cap but costs a 5% penalty,
  routed to reinsurance sellers.
- A long insurance lockup (200 ticks) prevents in-and-out gaming
  on direct insurer positions.

These mechanisms collectively rule out "deposit, collect premium,
front-run a likely trigger, withdraw" attacks. Capital flight is
structurally bounded.

---

## 5. The Trading Venue (secondary value prop)

### 5.1 LAP auction

The auction matches participants on a *geodesic* leverage
distribution in log-space — a bimodal log-normal mixture
(low-leverage and high-leverage modes, blended by directional
ratio) with a Cornish-Fisher 2nd-order skew/kurt correction. Each
medium tick:

1. Participants submit (side, leverage, margin, tip-tier) bids.
2. The auction builds the ideal density, computes the actual
   density, and adapts the meta-parameters $(\mu_{\text{low}},
   \alpha, \sigma_{\text{mix}}, \mu_{\text{high}})$ via one step of
   KL-gradient descent.
3. *Entropy weights*: per-bucket KL divergence between ideal and
   actual fills determines a tip multiplier $1 + \beta_E (KL_i /
   \max_j KL_j)$. Under-supplied buckets earn a premium.
4. Matching uses sort-and-align (provably optimal for minimising
   $\sum |L_{\text{long}} - L_{\text{short}}|$), continuous fill
   at $\min(L_{\text{long,max}}, L_{\text{short,max}})$.

### 5.2 Pay-for-the-unpopular-side

The entropy multiplier is the venue's structural innovation. When
the book is tilted long, shorts receive a tip premium proportional
to KL divergence. The tip is paid by the long counterparty as part
of the match — net cost of leverage on the unpopular side can be
zero or negative.

### 5.3 Transparent A/B classifier

Every user has a rolling 10-close skill score
$\text{score} = 0.5 \, \overline{R} + 0.3 (W - 0.5) \cdot 2 + 0.2 \, S$
where $\overline{R}$ is mean return, $W$ is win rate, $S$ is
Sharpe. Users with $\text{score} > 0.05$ are A-classified
(peer-matched); below are B-classified (route to the B-book pool).
Whales — single positions $> 2 \times$ rolling-average margin —
are force-classed to A regardless of score.

The classifier is *fully visible*: every user sees their score,
components, current class, and the precise gap to A. There is no
hidden routing.

---

## 6. Safety Analysis

### 6.1 Conservation invariants

For every medium tick $t$, the protocol enforces

$$
\sum_{u \in \text{users}} \Delta\text{wealth}_u(t) + \sum_{r \in \text{roles}} \Delta\text{role-stake}_r(t) = 0
$$

up to numerical tolerance. The only exogenous inflow is T-bill
yield (paid by the virtual external Treasury). Every other flow —
premium in/out, claim in/out, reinsurance payouts/seller losses,
auction tips, B-book P&L — is internally zero-sum.

This is enforced by `conservation.test.js` and
`integration.test.js`, run on every commit.

### 6.2 Empirical safety claim

The *strong* form of the safety claim — "no user ever loses money"
— is mathematically impossible for any leveraged or insurance-
adjacent protocol. The *correct* claim is

$$
\Pr\bigl( \text{joint outcome}_T(\text{user}) \geq 0 \bigr) \approx 1
$$

evaluated under realistic stress scenarios, where the joint
outcome is the sum of the user's wallet and redeemable thread
principal at the end of period $T$.

We verify this with the Monte Carlo harness (`lib/stressHarness.js`,
`scripts/runStress.mjs`). Across seven scenarios at n=200 each:

| Scenario | $\Pr(\geq 0)$ | $\overline{Y}$ ann. | $Y_{\text{worst}}$ |
| :-- | :--: | :--: | :--: |
| CALM | 100% | 8.6% | +4.5% |
| SINGLE_EVENT | 100% | 8.5% | +4.3% |
| CORRELATED_CRISIS | 100% | 8.1% | +3.9% |
| REDEMPTION_PRESSURE | 100% | 8.6% | +4.5% |
| BBOOK_VOLATILE | 100% | 13.7% | +1.5% |
| BBOOK_LOSING_STREAK | 100% | 4.0% | +1.5% |
| BBOOK_TAIL_EVENT | 96% | 13.0% | −4.0% |

The single failure mode (4% in BBOOK_TAIL_EVENT) is users
absorbing the 10%-of-face deductible during fat-tail events. A
tightened deductible (e.g., 5% of face) would push this to 100% at
the cost of higher reinsurance premiums.

### 6.3 What the harness verifies and what it doesn't

**Verified**:
- Per-tick conservation across all simulated cash flows
- Joint outcome distribution under synthetic event probabilities
  and synthetic B-book P&L
- Deterministic reproducibility from seed
- Lockstep damage / growth across the four layers

**Not yet verified**:
- Behaviour against actual historical price paths (Tier 1.4 of the
  roadmap — wire `replayAdapter` to real tick data)
- Capital-flight dynamics with sellers withdrawing mid-scenario
- Production-scale liquidity (the in-browser
  `LocalBroadcastAdapter` supports cross-tab demos, not real
  multi-user load)
- Adversarial coordination (collusion among B-classified users,
  coordinated front-running of insurance triggers)

These represent specific empirical gaps the roadmap will address.

---

## 7. Calibration

### 7.1 Parameter table

Default parameters and their roles:

| Constant | Value | Annualised | Role |
| :-- | :--: | :--: | :-- |
| `TBILL_RATE` | 0.04 | 4.0% | Layer-1 risk-free rate |
| `BASE_PREMIUM_RATE` | 0.0003 / settlement | ≈5.5% | Insurance premium base |
| `REINSURANCE_BASE_RATE` | 0.0002 / settlement | ≈3.65% | Reinsurance premium base |
| `BBOOK_REINS_BASE_RATE` | 0.0002 / LAP-tick | ≈3.65% | B-book reinsurance premium base |
| `INSURANCE_STRIDE` | 2 | — | Coprime stride for epoch separation |
| `INSURANCE_LOCKUP_EPOCHS` | 200 | — | Direct insurer-stake lockup |
| `REINSURANCE_LOCKUP_EPOCHS` | 200 | — | Reinsurance seller lockup |
| `BBOOK_REINS_LOCKUP_EPOCHS` | 200 | — | B-book reinsurance seller lockup |
| `BBOOK_REINS_ATTACHMENT_FRAC` | 0.10 | — | Layer-3 reinsurance deductible |
| `BBOOK_REINS_DEFAULT_FACE_FRACTION` | 0.30 | — | Auto-mint layer-3 hedge size |
| `STANDARD_REDEMPTION_CAP_PCT` | 0.10 | — | Per-cycle redemption cap |
| `EXPRESS_PENALTY_RATE` | 0.05 | — | Express redemption penalty |
| `BBOOK_MAX_NOTIONAL_RATIO` | 1.5 | — | B-book pool capacity gate |

### 7.2 Calibration history

The harness has guided several rounds of recalibration:

1. **Sprint 4** built the harness and revealed initial calibration
   was off: the protocol delivered *negative* joint outcomes even
   in CALM because `REINSURANCE_BASE_RATE = 0.010` per tick
   annualised to ≈365% — the reinsurance hedge cost exceeded the
   insurance premium income.
2. **Sprint 4.5** reduced both base rates 100×, bumped `TBILL_RATE`
   from 0.001 (≈0.1% annual) to 0.04 (4% annual), and changed the
   auto-mint reinsurance face from 1.5× principal to 1.0× principal.
   It also fixed a double-counting bug where insurance claim losses
   were being charged to both the wallet and the thread principal.
3. **Sprint 4.5b** retuned `BASE_PREMIUM_RATE` upward (0.00005 →
   0.00015) because at the post-Sprint-4.5 rate, insurance
   underwriting yielded only 1.8% annual — below T-bill — so being
   an underwriter wasn't rewarded. It also relaxed the MIN-rate
   floor from 0.1× base to 0.01× base so heavily oversupplied
   markets can self-correct via natural seller exit.
4. **Tier 1.0** doubled both base rates again to compensate for the
   halved settlement frequency introduced by `INSURANCE_STRIDE = 2`.

Each step was validated against the harness, with the joint-outcome
distribution acting as the empirical gate. The current calibration
is the first to reach the safety claim.

---

## 8. Theoretical Extensions

The current protocol implements a working, empirically-verified
version of the four-layer thread. Several extensions become
possible with more sophisticated logic; this section outlines the
most promising directions.

### 8.1 Pricing sophistication

**Per-event Bayesian pricing.** Instead of a uniform
`BASE_PREMIUM_RATE` shared across all event markets, integrate
observed historical frequency to set per-event base rates that
update as data accumulates. For event $e_i$ with observed
trigger frequency $\hat{f}_i$ and protocol-team prior $p_i$:

$$
r_{0,i} = \alpha \, p_i + (1 - \alpha) \, \hat{f}_i, \quad \alpha \rightarrow 0 \text{ as data accumulates}
$$

This addresses the cold-start problem (where there's no data,
the prior dominates) while letting the market converge to
empirically correct prices over time. Without it, common events
are systematically underpriced and rare events overpriced.

**Yield-curve-based event pricing.** Different events on
different time horizons (1-week vs 1-year crashes) priced via
term-structure analysis. Borrows from the credit-spread
literature: longer horizons should command lower per-period
rates if the underlying probability is well-calibrated, modulo
volatility risk premia.

**Correlation-aware reinsurance.** Currently the three
reinsurance products are independent. A more sophisticated
design would model correlation between buyers' insurance
exposures, charging a *concentration premium* when one buyer's
covered events are highly correlated. Otherwise diversified
buyers cross-subsidise concentrated ones.

**ML-driven risk assessment.** Train a model on order flow,
classifier transitions, regime detection, and historical event
triggers to produce a real-time *risk score* for the entire
system. The score becomes input to dynamic premium scaling:
when system risk is high, base rates rise system-wide.

### 8.2 Capital efficiency

**Cross-thread netting.** When user A has insurance-seller
exposure that hedges user B's exposure (e.g., one is short BTC,
the other long), allow netting at the protocol level so the
collective capital required is strictly less than $E_A + E_B$.
This is how clearing houses generate efficiency without taking
on credit risk.

**Multi-asset thread layers.** Extend beyond insurance markets
to include real-world assets (RWA), credit, sovereign debt as
additional layers. The same dollar could simultaneously be a
T-bill, an insurance stake, a B-book stake, a TT face, *and* a
fractional claim on a tokenised RWA portfolio. Each additional
uncorrelated layer tightens the joint distribution further.

**Secondary market for thread positions.** Tradable thread
positions (NFT-shaped) so users can exit before the redemption
queue clears. The buyer takes on the thread's full layer state
including any drawdowns. This adds liquidity without compromising
the protocol's capital adequacy — the principal stays in place,
ownership transfers.

**Generalised buffer policies.** Currently every thread runs
the same buffer policy (gains fatten layers 1–3, leave layer 4
unchanged). Generalised: let users choose where on the buffer
spectrum they want to be — more buffer = more downside
protection but lower realised yield; less buffer = higher
realised yield but less protection. Implement as a per-thread
parameter $\gamma \in [0, 1]$:

$$
\Delta F = \gamma \cdot G \quad\text{(fraction of gain that auto-mints additional TT)}
$$

### 8.3 Robustness

**Adversarial coordination defenses.** What if a coordinated
group of B-classified users front-run insurance triggers?
Possible detections: anomalous correlation in B-classified
order flow, sudden mass-tier transitions, classifier-failure
metrics. A protocol-level circuit breaker auto-pauses new
B-book contracts when these metrics breach thresholds.

**System health auto-pause.** Real-time risk score, with
auto-pause of new mints (not redemptions — redemptions must
always work) when the score drops below a configured floor.
This is the financial equivalent of a stock-exchange
circuit breaker.

**Stress bonuses with auction mechanism.** Instead of static
stress bonus payments to sellers who stay through volatility,
auction off the bonus to the most-committed sellers. The bonus
budget comes from a small skim on insurance premium collected
during high-volatility regimes, building a counter-cyclical
reserve.

**Counter-cyclical insurance yield.** Restore the pre-Phase-5
mechanic: KL divergence between ideal and actual fill
distributions drives a multiplier on insurer payouts. Crises
pay underwriters more, which keeps capital locked precisely
when the system needs it most.

### 8.4 Composability

**Cross-protocol thread composition.** Threads from Trading
Tower used as collateral in another DeFi protocol. The thread's
TT face is already stable-token-shaped, but the *underlying
principal* could also be exposed as collateral via a redemption
proof. Damage in either protocol propagates through the thread.

**Composable insurance.** Insurance contracts that themselves
can be securitised and traded — a market for insurance
positions. Speculators who think specific events are
under-priced can buy and resell coverage without underwriting
themselves.

**On-chain implementation.** Solidity port of `lib/towerTether.js`
+ `lib/bBookPool.js` + `lib/insuranceMarket.js` with formal
verification of the lockstep invariants. This is non-trivial:
the four-layer lockstep needs to be expressed as a Solidity
modifier that atomic-applies all four state changes per damage
event, with revert on any partial failure.

**Quantum-resistant signature schemes.** For long-duration
threads (years to decades), the protocol's identity layer should
support post-quantum signature algorithms (Dilithium, Falcon).
This is more about durability than current threat: a thread
opened in 2025 should still be valid in 2045 if the user kept
their key.

### 8.5 Governance

**DAO governance over parameters.** Let users vote on
`BASE_PREMIUM_RATE`, `INSURANCE_LOCKUP_EPOCHS`,
`BBOOK_REINS_ATTACHMENT_FRAC`, etc. The harness's empirical
verification gate should be part of the proposal process —
parameter changes that fail the joint-outcome test cannot be
ratified.

**Self-balancing pool topology.** The pool automatically
reallocates seller capital across reinsurance products based
on observed risk-adjusted returns over a rolling window.
Stagnant capital migrates to better-yielding tranches; chronic
underwriters of bad risk are gradually downsized.

### 8.6 User-facing improvements

**Privacy-preserving classifier.** Use zero-knowledge proofs
to let users prove their classification status without
revealing trade history. This addresses the privacy concern
that the *transparent* classifier exposes individual P&L
patterns.

**Tiered B-book classification.** Instead of binary A/B,
multi-tier classification (A, A-, B+, B, B-) that gradually
adjusts routing fractions. A trader at the boundary
(score = 0.04) routes 80% to peer / 20% to pool, smoothly
shifting as their score evolves.

**Reinsurance laddering.** Reinsurance products with different
attachment / exhaustion levels for buyers wanting custom risk
profiles. The current 30/30/40 product structure becomes one
dimension; attachment becomes another.

### 8.7 What advanced logic is *not* expected to do

It's worth being explicit about what these extensions cannot
deliver:

- **Eliminate tail risk entirely.** Even with all of the above,
  there exist multi-sigma joint events that overwhelm the
  reinsurance pools. The safety claim is *high probability of
  joint outcome ≥ 0*, not certainty.
- **Compete on yield with concentrated leveraged products.** A
  protocol that prioritises bounded downside cannot match a
  100x-perp on upside. It can match a HYSA + meaningful kicker.
- **Bypass regulatory complexity.** The triple-touch problem
  (insurance + leveraged trading + stablecoin) is structural and
  cannot be engineered away. Friendly-jurisdiction strategy and
  decomposed legal entities are non-engineering work.

---

## 9. Mathematical Foundations

This section develops the protocol's mathematics more rigorously
than the implementation-focused earlier sections.

### 9.1 Capital efficiency theorem

The headline efficiency claim — *"the same dollar can earn from
multiple roles simultaneously"* — has a precise statement.

Let $X_1, \dots, X_n$ be the per-period returns from $n$
candidate yield sources, with $E[X_i] = \mu_i \geq 0$ and
$\text{Var}(X_i) = \sigma_i^2$. Let $\rho_{ij}$ be their pairwise
correlation. A *standard* portfolio approach — split $\$1$ into
$n$ pieces of size $w_i$ with $\sum w_i = 1$ — yields

$$
\mu_{\text{split}} = \sum w_i \mu_i, \qquad
\sigma_{\text{split}}^2 = \sum_{i,j} w_i w_j \rho_{ij} \sigma_i \sigma_j.
$$

The *thread* approach instead lets the same $\$1$ play all $n$
roles simultaneously, accumulating each role's return:

$$
\mu_{\text{thread}} = \sum \mu_i, \qquad
\sigma_{\text{thread}}^2 = \sum_{i,j} \rho_{ij} \sigma_i \sigma_j
$$

(equivalent to portfolio weights $w_i = 1$ for all $i$).

The expected-return improvement is

$$
\frac{\mu_{\text{thread}}}{\mu_{\text{split}}} = \frac{\sum \mu_i}{\sum w_i \mu_i} = n \quad \text{when } w_i = 1/n.
$$

The variance ratio is

$$
\frac{\sigma_{\text{thread}}^2}{\sigma_{\text{split}}^2} = n^2 \quad \text{(also)}
$$

so the *Sharpe* ratio is invariant under the standard split:
both deliver the same risk-adjusted return. The thread's
benefit is in *gross yield magnitude per dollar of deployed
capital*, not in Sharpe alone.

The benefit becomes structural when correlations are imperfect.
For uncorrelated yields ($\rho_{ij} = 0$ for $i \neq j$):

$$
\sigma_{\text{thread}} = \sqrt{\sum \sigma_i^2}
$$

vs. the naïvely-additive worst-case
$\sigma_{\text{worst}} = \sum \sigma_i$. The ratio is
$1/\sqrt{n}$, so a 4-layer thread with uncorrelated layers has
half the volatility of a naïve linear stack. This is the
*structural* efficiency: capital is virtually deployed across
$n$ roles with $\sqrt{n}$-times-better risk-adjusted scaling
than a naïve linear stack would suggest.

The **safety claim** — joint outcome positive with high
probability — depends critically on $\rho_{ij}$ being small for
the chosen yield sources. The current 4-layer design picks T-bill,
event insurance, retail-flow underwriting, and stablecoin
optionality precisely because their correlation structure is
favourable in stress.

### 9.2 Conservation invariants — formal

Let $W_u(t)$ be user $u$'s wealth at tick $t$, defined as
wallet margin plus the redeemable value of any open thread
plus B-book voluntary stake. The protocol's conservation
invariant is

$$
\sum_{u \in U(t)} \bigl[ W_u(t) - W_u(t-1) \bigr] = E(t)
$$

where $E(t)$ is the *exogenous inflow* at tick $t$. In the
current implementation $E(t)$ is exclusively T-bill yield paid
by the virtual external Treasury:

$$
E(t) = \text{TBILL\_RATE}/365 \cdot \sum_u P_u(t-1)
$$

where $P_u$ is the principal locked in user $u$'s active
threads.

All other flows — premium in/out, claim in/out, reinsurance
payouts, B-book P&L, auction tips, redemption dollars —
are internally zero-sum. This is enforced by
`conservation.test.js`: any tick whose net flow deviates from
$E(t)$ by more than numerical tolerance fails the test.

### 9.3 Lockstep invariant — formal

For any thread $T = (\text{owner}, P, F, \mathbf{w}, \tau_0)$
and any damage event of size $L$:

$$
\Delta P = -\min(P, L), \quad
\Delta F = \min(0, P + \Delta P - F),
$$

$$
\Delta \text{layer-2}_i = w_i \cdot |\Delta P|, \quad
\Delta \text{layer-3} = |\Delta P|.
$$

In words: principal shrinks by $\min(P, L)$; layer-2 stakes in
covered markets shrink by $w_i$ shares of that amount; layer-3
B-book stake shrinks by the full amount; layer-4 face shrinks
*only* if the post-update principal is below the current face
(otherwise face is preserved, and the difference $P - F$ is
the buffer).

Symmetrically for growth event of size $G$:

$$
\Delta P = +G, \quad \Delta F = 0
$$

Layer-1, 2, 3 fatten by $G$; layer 4 is non-elastic. The
invariant $P \geq F$ is preserved; the buffer $P - F$ grows
by $G$.

### 9.4 Epoch-separation invariant — formal

For all threads $T$ and all medium ticks $t$:

$$
\bigl|\Delta P_{\text{insurance}}(T, t)\bigr| \cdot \bigl|\Delta P_{\text{LAP}}(T, t)\bigr| = 0.
$$

Either insurance damage is zero this tick, or LAP damage is
zero this tick. This is enforced structurally:
`mediumCount % INSURANCE_STRIDE === 0` gates insurance settlement,
and the off-stride is reserved for LAP/B-book settlement. Coprime
strides cannot generate simultaneous damage.

### 9.5 Equilibrium of supply-and-demand pricing

The premium-rate formula

$$
r = r_0 \cdot \sqrt{C / S}
$$

(where $C$ is coverage demand and $S$ is supply) defines an
equilibrium when both sides have elastic responses to rate.

Suppose buyers' demand is $C(r) = C_0 \, r^{-a}$ (more demand
at lower rate, elasticity $a > 0$) and sellers' supply is
$S(r) = S_0 \, r^{b}$ (more supply at higher rate, elasticity
$b > 0$). The equilibrium rate $r^*$ satisfies

$$
r^* = r_0 \sqrt{\frac{C_0 (r^*)^{-a}}{S_0 (r^*)^b}} \implies (r^*)^{1 + (a + b)/2} = r_0 \sqrt{C_0 / S_0}
$$

so $r^* = (r_0 \sqrt{C_0/S_0})^{2/(2 + a + b)}$.

The square-root sensitivity in the protocol's formula
($a + b = 0$ in the naïve case) means $r^*$ adjusts strongly
to imbalance. For elastic users ($a + b > 0$), the equilibrium
is more damped — closer to $r_0$ — reflecting how real markets
behave.

The MIN/MAX clamps are *non-equilibrium guards*: they activate
only when one side is so unresponsive that the natural $r^*$
would be pathological.

### 9.6 Risk-bearing capacity

Define the protocol's *capacity* $K$ as the maximum total
deposit it can absorb before some safety-claim metric fails.
Specifically, let $K_{99}$ be the largest $D$ such that
$\Pr(\text{joint outcome}_T \geq 0) \geq 0.99$ across the
canonical stress scenarios at total deposit $D$.

In the current calibration, the harness validates $K_{99}$ for
single-user deposits up to the test ceiling. Multi-user scaling
introduces additional considerations:

- **Insurance market depth**: $S_i$ must scale with total
  user demand; otherwise $C_i / S_i$ gets large and rates rise.
- **Reinsurance pool capacity**: total seller capital must
  exceed expected aggregate buyer loss in stress. Current
  harness uses 10× user deposit as the synthetic seller pool;
  production needs explicit capacity targets.
- **B-book pool depth**: pool stake must be large relative to
  active LAP notional. The `BBOOK_MAX_NOTIONAL_RATIO = 1.5`
  gate provides a static cap; dynamic capacity scaling would
  improve utilisation.

A *capacity audit* — running the harness at various deposit
scales to find $K_{99}$ as a function of pool depths — is a
prerequisite for any production deployment.

### 9.7 Game-theoretic analysis of the classifier

The A/B classifier is *truthfully revealing* if users have no
incentive to misrepresent their skill. Direct misrepresentation
isn't possible (the classifier scores observed P&L, not user
claims). Indirect manipulation strategies and their defenses:

- **"Lose small, bet big"** — make small losing trades to stay
  B-classified, then make a single large bet against the pool.
  Defense: whale exception. Any single position with
  $\text{margin} > 2 \times$ rolling-average-margin is
  force-classed to A regardless of score.
- **Sybil attacks** — split positions across many fake accounts
  to stay below the whale threshold. Defense: KYC / unique
  identity binding (regulatory layer).
- **Coordinated B-trading** — multiple genuinely B-classified
  users coordinate the same trade. Defense: classifier
  monitoring for anomalous correlation in B-flow (Section 8.3).

The classifier's transparency is itself a defense: users can
verify their classification and appeal misclassification, which
makes mass attacks more visible to other participants.

---

## 10. Additional Thread Layers

The protocol's load-bearing innovation is the four-layer
thread. The pattern generalises: any *yield-producing role*
that satisfies a few criteria can be added as a new layer,
each one widening the joint-distribution stack.

This section catalogues candidate layers, the criteria for
inclusion, and worked examples of extended thread designs.

### 10.1 Criteria for a candidate layer

For a role to be addable as a thread layer, it must satisfy:

1. **Positive expected return.** $E[\text{layer yield}] > 0$
   under realistic assumptions. (Otherwise the user pays for
   the role rather than earning from it; that's a hedge, not
   a layer.)
2. **Bounded downside per period.** Loss in the layer is
   capped at some fraction of the deployed capital. (Unbounded
   loss layers can't be safely combined — one bad period and
   the thread is wiped out regardless of buffer.)
3. **Low correlation to existing layers.** $\rho < 0.3$ to all
   other layers in normal conditions; $\rho < 0.7$ in stress.
   (Correlation in stress is what matters most — high stress
   correlation defeats the joint-outcome safety claim.)
4. **Compatible with lockstep semantics.** The layer must
   support pro-rata damage: when the thread principal is
   debited by $L$, the layer's deployed capital must shrink
   proportionally. Mechanisms incompatible with pro-rata
   shrinkage (e.g., locked NFT collateral, indivisible
   positions) cannot be layers.
5. **Operational tractability.** The layer must settle on the
   protocol's clock (medium-tick or coprime stride). Layers
   with long settlement cycles (monthly RWA dividend
   distributions) need to be modelled as pro-rated accruals.

### 10.2 Two flavors of extension: *virtual roles* and *principal diversification*

The four current layers fall into two categories:

- **Virtual roles** (insurance seller, B-book underwriter):
  The user's principal sits in T-bill (layer 1), but the user
  *also* declares themselves the seller in markets that
  don't require physical capital movement. Premium/claim
  flows happen at trigger; the principal moves only on
  damage.
- **Physical anchor** (T-bill): The user's principal must
  actually be in a Treasury security to earn the risk-free
  yield.

Adding more **virtual roles** is straightforward — any
two-sided market for protection can be layered into the
thread. Adding more **physical anchors** requires diversifying
the principal across multiple instruments; this changes layer
1 from "T-bill" to "a portfolio of risk-free or near-risk-free
instruments". Both are valuable; they extend the thread along
different axes.

### 10.3 Catalog of candidate virtual roles

Each entry below describes a candidate layer, its yield source,
risk profile, correlation to existing layers, and operational
shape.

#### 10.3.1 Catastrophe-bond underwriting (Layer 5 candidate)

- **Yield**: Premium income from buyers of natural-catastrophe
  protection (hurricane / earthquake / wildfire / flood).
- **Risk**: Pays out on catastrophe trigger. Triggers are
  parametric (wind speed, ground acceleration, claims
  threshold) — no claims adjudication.
- **Correlation**: Near-zero with financial layers (1–4).
  Catastrophes are weather/geological, decoupled from market
  regime. This is the gold-standard *uncorrelated* yield
  source.
- **Operational shape**: Same as Section 3.1 insurance markets,
  but with parametric triggers from an oracle network (NWS, USGS).
- **Yield range**: 5–15% annual, depending on coverage tier.

This is the strongest candidate for a 5th layer — high yield,
genuinely uncorrelated, well-understood actuarial pricing.

#### 10.3.2 Credit-default protection (Layer 6 candidate)

- **Yield**: Premium income from buyers of credit-default
  protection on a diversified corporate-credit basket.
- **Risk**: Pays on default of the referenced credits. Pro-rata
  loss capped at notional.
- **Correlation**: Moderate-to-high in stress (recessions
  cluster credit losses with equity drawdowns). Low in normal
  conditions.
- **Operational shape**: Two-sided market; trigger is
  protocol-defined "default" (e.g., S&P / Moody's downgrade
  to default, or contractually-defined credit event).
- **Yield range**: 1–5% annual on investment-grade; 5–15%
  on high-yield.

The stress correlation is the issue. If the thread is heavily
exposed to layer-6 in a recession AND layer-3 (B-book) suffers
from coordinated retail trading the same recession, both layers
hit at once. Acceptable only with reinsurance specifically
covering layer-6.

#### 10.3.3 Volatility-selling roles (Layer 7 candidate)

- **Yield**: Premium income from selling at-the-money options
  (covered calls + cash-secured puts) on a diversified equity-
  index basket.
- **Risk**: Loss when realised volatility exceeds implied; pays
  the option payoff at expiry.
- **Correlation**: Moderate-high to layer-3 in stress (vol
  spikes happen during retail-coordinated moves).
- **Operational shape**: Synthetic — user is the implicit
  short-vol counterparty in a protocol-managed options book.
  Settlement at expiry; mark-to-market each tick.
- **Yield range**: 4–10% annual, with occasional double-digit
  drawdowns.

Vol-selling is the closest analogue to the existing B-book
layer in risk profile. Its inclusion would require careful
correlation modelling against layer-3.

#### 10.3.4 Funding-rate capture (Layer 8 candidate)

- **Yield**: Funding payments from perpetual-futures longs in
  positive-funding regimes (which is the historical default).
- **Risk**: Funding can flip negative; the user pays funding to
  shorts. Bounded by the daily funding cap.
- **Correlation**: Mixed — funding correlates with directional
  market sentiment, weakly with insurance event triggers.
- **Operational shape**: Synthetic short-perp position
  collateralised by spot. Net delta = 0 (basis trade).
  Continuous funding income stream.
- **Yield range**: 5–20% annual in bull markets; can be
  zero-or-negative in bear markets.

This is the design used by Ethena's USDe — it's a real,
shipped pattern at scale. Direct addition as a thread layer is
plausible but the basis-trade mechanics need careful
implementation (perp exchange counterparty risk, funding-rate
oracle, cross-margin accounting).

#### 10.3.5 Mortality / longevity underwriting (Layer 9 candidate)

- **Yield**: Premium from life-insurance / annuity buyers.
- **Risk**: Pays out on mortality (life insurance) or longevity
  (annuity exhaustion).
- **Correlation**: Effectively zero with financial markets —
  human mortality dynamics are decoupled.
- **Operational shape**: Long-tenor — claims happen over
  decades. Suitable for thread layers held for years.
- **Yield range**: 3–6% annual.

Mortality is the highest-quality uncorrelated yield source
known to finance, but its operational complexity (long horizons,
regulatory framework, actuarial expertise) makes it a
medium-term rather than short-term addition.

#### 10.3.6 Weather derivatives (Layer 10 candidate)

- **Yield**: Premium from buyers of weather protection
  (heating-degree-days, cooling-degree-days, rainfall
  thresholds).
- **Risk**: Pays out on weather threshold breach.
- **Correlation**: Near-zero with financial layers; mild
  correlation with catastrophe-bond layer (severe weather → cat
  events).
- **Operational shape**: Same as parametric catastrophe layer,
  with weather oracles instead of seismic oracles.
- **Yield range**: 4–8% annual.

Weather is a natural extension of catastrophe-bond underwriting
— same operational pattern, slightly different correlation
structure.

### 10.4 Catalog of candidate principal diversifications

Where the virtual roles add yield streams without moving
capital, *principal diversification* changes what backs layer 1
itself. The pure-T-bill anchor becomes a portfolio.

#### 10.4.1 Multi-jurisdiction sovereign basket

Replace the single T-bill with a basket: 50% US 3-month
T-bill, 20% UK 3-month gilt, 15% German Bund, 10% Japan JGB,
5% Swiss bond. The basket diversifies sovereign risk; yields
are similar (~3–4% annual range). Correlation is moderately
high in stress (flight-to-quality concentrates in the largest
sovereign).

Implementation: oracle-priced fungible-token wrappers of each
sovereign instrument, with rebalancing rules.

#### 10.4.2 Tokenised commercial paper / repo

Add 10–20% allocation to high-quality short-term commercial
paper (CP) or overnight repo. Slightly higher yield than
T-bill (4.5–5%); slightly higher credit risk. Correlation
with T-bill is high but not 1.0.

Implementation: protocols like Ondo, Maple, or institutional
RWA tokenisation services. Requires KYC for the issuer; the
protocol accepts the tokenised exposure.

#### 10.4.3 Money-market fund (MMF)

Add a slice of allocation to a tokenised money-market fund.
Diversified across multiple short-term instruments; daily
liquidity; ~4% annual.

Implementation: any of the major tokenised MMFs (BlackRock
BUIDL, Franklin Templeton FOBXX). The protocol holds the
tokenised share class.

#### 10.4.4 Inflation-linked bonds

Add 5–10% allocation to TIPS or equivalent. Hedges inflation
risk on the rest of the principal. Negative correlation to
layer-3 in inflation-induced market stress.

#### 10.4.5 Real-estate-backed debt

Add 5–10% allocation to senior real-estate debt tokens. Higher
yield (6–9%); illiquid. Correlation with financial layers is
moderate (real-estate moves with credit cycles).

### 10.5 Composition rules and correlation algebra

When adding $k$ new layers, the resulting joint-outcome
distribution is governed by the full $(n+k) \times (n+k)$
correlation matrix. Adding a layer is *strictly safety-improving*
if its correlation to existing layers is below the existing
inter-layer correlations — the new joint distribution is
tighter.

Practical heuristic: before adding a layer, run the harness with
the proposed addition and verify $\Pr(\text{joint outcome} \geq 0)$
*does not decrease* in any existing scenario. If it decreases,
the layer is correlated enough in stress to dominate the
diversification benefit and should not be added.

This gives the harness a concrete role beyond stress-testing:
it becomes the *acceptance gate* for new layers.

### 10.6 Worked example: 7-layer thread

A plausible Trading Tower v2 thread:

| # | Layer | Yield (typical) | Stress correlation to layer 1 |
| :--: | :-- | :--: | :--: |
| 1 | Multi-sovereign T-bill basket (60%) + MMF (20%) + commercial paper (20%) | 4.0% | — |
| 2 | Insurance-seller stakes across 16 standard events | 3.5% net | low |
| 3 | B-book pool stake (passive underwriter) | 2.5% net | low |
| 4 | TT face (stablecoin optionality) | — | n/a |
| 5 | Catastrophe-bond underwriting | 4.0% | near-zero |
| 6 | Weather-derivative underwriting | 2.5% | near-zero |
| 7 | Mortality / longevity underwriting | 2.5% | near-zero |

Joint expected yield (gross of premiums paid for hedges):
4.0 + 3.5 + 2.5 + 4.0 + 2.5 + 2.5 = 19.0% annualised.

Realistic *net* yield after reinsurance premia and expected
losses: 9–12% annualised, with the joint outcome positive
distribution remaining $\geq 95\%$ across canonical stress
scenarios — assuming the harness verifies the addition.

This is the upper bound of what the four-layer pattern can
support without entirely re-architecting the protocol.

---

## 11. Production Architecture

The current implementation is a single React SPA. A production
deployment needs explicit service boundaries and fault
isolation.

### 11.1 Layered system architecture

```
                       ┌────────────────────┐
                       │  Front-ends        │
                       │  · Web (easy mode) │
                       │  · Web (advanced)  │
                       │  · Mobile          │
                       │  · Public API      │
                       └─────────┬──────────┘
                                 │
                       ┌─────────▼──────────┐
                       │  API gateway +     │
                       │  auth (KYC bound)  │
                       └─────────┬──────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼──────┐         ┌───────▼──────┐         ┌───────▼──────┐
│ Order        │         │ User         │         │ Risk monitor │
│ matching     │         │ accounts     │         │ + circuit    │
│ engine       │         │ + sessions   │         │ breaker      │
└───────┬──────┘         └───────┬──────┘         └───────┬──────┘
        │                        │                        │
        └────────────────────────┼────────────────────────┘
                                 │
                       ┌─────────▼──────────┐
                       │  Settlement layer  │
                       │  (medium tick      │
                       │   orchestrator)    │
                       └─────────┬──────────┘
                                 │
        ┌────────────────────────┼────────────────────────┐
        │                        │                        │
┌───────▼──────┐         ┌───────▼──────┐         ┌───────▼──────┐
│ Smart        │         │ Oracle       │         │ Data /       │
│ contracts    │         │ network      │         │ analytics    │
│ (protocol    │         │ (price +     │         │ (audit log,  │
│  state)      │         │  events)     │         │  reporting)  │
└──────────────┘         └──────────────┘         └──────────────┘
```

### 11.2 Service responsibilities

**Smart contracts (protocol state).** The protocol's
authoritative state — threads, balances, insurance positions,
B-book stakes — lives on-chain. Updates are submitted via
signed transactions from the settlement layer.

**Settlement layer.** Off-chain orchestrator that runs the
medium-tick loop. Pulls order flow from the matching engine,
event triggers from the oracle network, computes the next
state, submits the resulting transactions. State machine runs
deterministically; replay-able from event log.

**Order matching engine.** High-frequency component (Rust, in
process) that maintains the LAP auction's order book. Supports
sub-millisecond match latency. Integrates with off-chain
trade preview before on-chain settlement.

**User accounts + sessions.** Standard authentication, KYC
binding, session management. Accounts are typed (retail,
professional, institutional) for jurisdiction-aware routing.

**Risk monitor + circuit breaker.** Watches the per-tick
metrics — pool capacity utilisation, classifier divergence,
realised volatility — and triggers protocol-level pauses when
thresholds breach.

**Oracle network.** Multi-source price feeds, parametric event
triggers, regime detection. Failover and aggregation logic
prevents single-oracle compromise.

**Data / analytics.** Time-series storage of every cash flow,
position, and metric. Powers the regulator-facing audit trail
and the public-facing transparency dashboard.

### 11.3 Failure isolation

Every service should fail independently. Specifically:

- **Smart contracts down** → users cannot mint or settle, but
  existing positions accrue normally; redemptions queue for
  next-block processing.
- **Settlement layer down** → state freezes at last committed
  block; trading halts; positions safe.
- **Order matching down** → trading halts; insurance and
  reinsurance settlement continue (they're independent of
  matching).
- **Oracle network down** → settlement uses last-known prices
  with explicit "stale" markers; trading halts; auto-pause if
  staleness exceeds threshold.
- **Risk monitor down** → no auto-pause; all other services
  continue, with manual oversight.
- **Front-end down** → public API still works; sophisticated
  users can interact via direct contract calls.

### 11.4 Capital flow architecture

User capital sits in a custody layer separate from the protocol
state:

- **Retail users**: custodial wallet, KYC'd, fiat on/off ramp
  via partnered banks. Funds custody-segregated by user.
- **Institutional users**: non-custodial, direct on-chain
  interaction.
- **Reinsurance sellers**: locked in dedicated vaults with
  defined withdrawal curves. Lockup release scheduled
  on-chain.

The protocol contracts hold *bookkeeping* state but not the
actual user funds. Cash flows route through the custody layer
on settlement.

---

## 12. Technology Stack

This section is opinionated. Each choice is justified by either
(a) maturity / audit history for security-critical components or
(b) ecosystem fit / hire-ability for everything else.

### 12.1 Smart contract layer

**Language**: Solidity 0.8.x. Most mature toolchain; deepest
auditor pool; maximal EVM compatibility.

**Toolchain**:
- `Foundry` for local development, fuzzing, invariant testing.
- `Slither` + `MythX` / `Semgrep` for static analysis.
- `Halmos` or `Certora` for formal verification of the
  lockstep / conservation invariants. The four-layer thread's
  damage propagation is a small enough state machine for
  symbolic verification to be tractable.
- `Echidna` for property-based fuzzing.

**Deployment target**: An L2 rollup. Specifically:
- **Arbitrum** or **Optimism** for established ecosystem +
  good liquidity + low gas.
- **Base** as a secondary if Coinbase distribution matters.
- Avoid L1 (gas costs make per-medium-tick settlement
  prohibitive). Avoid alt-L1s (Solana, Sui) for the v1 due to
  thinner audit ecosystems for novel protocols.

**Upgrade strategy**: Diamond proxy with timelock. Parameter
changes via DAO vote; logic upgrades require timelock + audit.

### 12.2 Off-chain settlement service

**Language**: TypeScript on Node.js. The current `lib/` is
already pure TypeScript-compatible; lift it directly.

**Runtime**: A long-running service that reads on-chain state,
pulls oracle data, computes next state, submits transactions.

**Determinism**: Service must be deterministic for replay.
- Inputs: previous on-chain state + oracle reads + order flow.
- Output: deterministic next state + transaction list.
- Verification: anyone can re-run with the same inputs and
  match the output.

**State management**:
- Event-sourcing pattern: every state change is an immutable
  event; current state is the fold over events.
- `PostgreSQL` with WAL replication for the event log.
- `Redis` for hot state (active orders, current balances).

**Transaction submission**:
- Multi-signer infrastructure (`Safe` multi-sig + `Defender`
  / `Tenderly Web3 Actions` for automation).
- MEV protection via private mempools (`Flashbots`,
  `MEV-Share`).

### 12.3 Order matching engine

**Language**: Rust. The auction's match-and-fill logic is
performance-critical; sub-millisecond latency matters at scale.

**Architecture**:
- Single-process matching engine per pair (horizontal scaling
  by pair, not by user).
- Lock-free order book using ring buffers.
- Deterministic ordering rules: timestamp + tie-breaker on
  user ID hash.

**Integration**: Off-chain order book; on-chain settlement.
Trades match off-chain in real time, batch-settle on the
medium tick. This is the standard model for non-CLOB DEXes
(`dYdX`, `Hyperliquid`).

### 12.4 Oracle infrastructure

**Price feeds**: `Chainlink` (mature, decentralised) +
`Pyth` (high-frequency, low-latency) cross-checked.
Settlement uses median-of-N with staleness checks.

**Event triggers**: Custom oracle network for protocol-specific
events (BTC -20% / week, vol spike, regime shifts). Operators
post observations; protocol uses median + dispute window. Can
bootstrap on `UMA` (optimistic oracle) for v1.

**Catastrophe / weather oracles** (for v2 layers): Chainlink's
nat-cat data feed, or partnership with a re/insurance data
provider (Munich Re Geo Risks, Aon Impact Forecasting).

### 12.5 Front-end and mobile

**Web**: Current React + Vite stack. Add `viem` + `wagmi` for
chain interaction. `WalletConnect` / `RainbowKit` for wallet
support. Server-side rendering optional.

**Mobile**: React Native with the same wallet infrastructure.
Mobile is a Tier-3 priority — initial users are
sophistication-self-selected and OK with web.

**Public API**: REST + WebSocket. REST for state queries and
order submission; WebSocket for real-time market data.
Standard rate limiting, JWT auth, OpenAPI specification.

**Documentation**: Auto-generated TypeScript SDK; live API
docs (Mintlify, ReadMe).

### 12.6 Data infrastructure

**Time-series storage**: `ClickHouse` for analytics queries
(per-tick metrics, P&L attribution, regulator-facing reports).

**Event log**: `Apache Kafka` for the cross-service event
backbone. Settlement service publishes events; analytics
consumes; risk monitor consumes.

**Metrics**: `Prometheus` + `Grafana` for service-level
monitoring. `Datadog` or `New Relic` for full-stack APM.

**Logging**: `OpenTelemetry`-compatible logging across all
services. Centralised in `Datadog Logs` or `Loki`.

### 12.7 Audit and verification

**Sequenced audits**: Two independent firms before mainnet.
Recommended: `Trail of Bits` + `Spearbit` (both have deep
DeFi protocol experience; complementary methodologies).

**Continuous verification**:
- Foundry invariant tests run on every PR.
- The Monte Carlo harness extended to historical replay
  (Tier 1.4) runs nightly against new code.
- Tenderly simulation of every parameter change against the
  current chain state before DAO vote.

**Bug bounty**: `Immunefi`, $1M+ for critical findings. Active
maintenance — the bounty is the canonical continuous audit
once the protocol is live.

### 12.8 Compliance integration

**KYC/AML**: `Sumsub`, `Persona`, or `Onfido`. Per-jurisdiction
verification levels (basic for retail, enhanced for
professional / institutional).

**Sanctions screening**: `Chainalysis` Address Screening or
`TRM Labs`. Real-time on every deposit/withdrawal.

**Reporting**: `Lukka` or in-house analytics for tax /
regulatory reporting. Should support FATF travel rule, Form
8949 generation, MiCA reporting.

**Custody**: `Anchorage` or `Fireblocks` for institutional
fund custody. Self-custody option for sophisticated users.

### 12.9 Why these choices

A pattern: prefer mature, audited tools for security-critical
components (Solidity, Foundry, Trail of Bits) and pragmatic,
fit-for-purpose tools for everything else. Don't be the first
team to use a novel toolchain in production — use the second
or third user's experience as your reference.

The cumulative engineering cost of building all this is
roughly:
- Smart contract layer: 6 months, 2–3 senior Solidity
  engineers + 1 verification specialist. ≈ $1.5M including
  audits.
- Off-chain services: 4 months, 2–3 senior backend engineers.
  ≈ $750k.
- Front-end / mobile: 3 months, 2 frontend engineers + 1
  designer. ≈ $400k.
- Compliance / legal: parallel track, ≈ $800k for first year
  including KYC integration and one major jurisdiction.
- Operations / infrastructure: ≈ $150k/yr ongoing.

**Total ballpark for v1 production launch**: $3–4M and 9–12
months from a working research artifact (roughly today's
state) to a hosted institutional-grade product. Retail-grade
adds another 12–18 months and $5–10M in additional regulatory
and product spend.

---

## 13. Limitations

The current implementation is a research artifact, not a
production system. Specifically:

- **Pre-production code.** State is per-browser localStorage, not
  a real backend. Multi-user works via `BroadcastChannel` (same
  machine, multi-tab) but protocol-global state diverges across
  tabs.
- **Synthetic stress.** The Monte Carlo harness uses
  protocol-defined event probabilities, not historical replay.
  Tier 1.4 of the roadmap addresses this.
- **No formal solvency proof.** Conservation invariants are
  runtime-tested but not formally verified. A real audit will
  require formal proofs.
- **No regulatory framing.** The product touches insurance,
  leveraged trading, and stablecoin issuance simultaneously —
  a triple-touch in most jurisdictions. Legal strategy is open.
- **Calibration is empirical, not derived.** Each parameter has
  been tuned against the harness's joint-outcome distribution,
  not derived from first principles. A future calibration study
  would document the sensitivity of headline metrics to each
  parameter.

---

## 14. Conclusion

Trading Tower demonstrates that capital efficiency and bounded
downside are not necessarily in tension. The four-layer thread
mechanism puts one dollar in four uncorrelated yield-producing
roles simultaneously, with damage propagation in lockstep and
growth accumulating as a buffer that absorbs subsequent damage
before TT face is at risk. The reinsurance architecture covers the
two layers most exposed to event risk (insurance) and active-trader
counterparty risk (B-book). The transparent A/B classifier directly
addresses the structural moral problem of CFD broker B-book trading.

We have empirically verified the safety claim across seven stress
scenarios with deterministic Monte Carlo. The calibration question
is settled in the sense that the parameters work; it remains open
in the sense that historical replay and seller capital-flight
dynamics are not yet exercised.

The forward-looking section identifies several extensions that
would substantively improve the protocol — Bayesian event pricing,
cross-thread netting, on-chain implementation with formal
verification — without changing the core mechanism. The four-layer
thread is the design's load-bearing innovation. Everything else is
infrastructure around it.

---

## Appendix A — Notation

| Symbol | Meaning |
| :-- | :-- |
| $T = (\text{owner}, P, F, \mathbf{w}, \tau_0)$ | A thread |
| $P$ | Thread principal (layer 1) |
| $F$ | Thread TT face (layer 4) |
| $\mathbf{w}$ | Insurance fill weights (layer 2) |
| $C_i, S_i$ | Coverage / insurer stake in market $i$ |
| $r_0$ | `BASE_PREMIUM_RATE` |
| $c_k$ | Reinsurance product $k$'s coverage fraction |
| $\beta_E$ | `ENTROPY_BETA` |
| $\pi_t$ | User's per-tick B-book P&L |

## Appendix B — Implementation modules

| Module | Role |
| :-- | :-- |
| `lib/towerTether.js` | Threads, mint, damage / growth, redemption cycle, solvency check |
| `lib/insuranceMarket.js` | Per-event two-sided markets, settlement, premium rate |
| `lib/reinsurance.js` | Three-product reinsurance covering insurance sellers |
| `lib/bBookReinsurance.js` | Single-product layer-3 hedge with HWM stop-loss |
| `lib/bBookPool.js` | B-book counterparty pool, voluntary + thread-derived stake |
| `lib/userClassifier.js` | Transparent A/B classification with whale exception |
| `lib/auction.js` | Geodesic-distribution LAP auction with entropy weights |
| `lib/ltv.js` | 5-term LTV + tier-3 hard gate |
| `lib/capitalTags.js` | Same-capital tagging across roles |
| `lib/conservation.js` | Per-tick conservation invariant checker |
| `lib/stressHarness.js` | Monte Carlo harness with seven scenarios |
| `hooks/useEpochLoop.js` | Three-stride orchestration with epoch separation |

## Appendix C — Reproducibility

Every stress harness run is seeded. To reproduce a specific
joint-outcome:

```bash
npm run stress -- --n 200 --scenario CORRELATED_CRISIS
```

The output reports `P(joint outcome ≥ 0)`, mean, percentile
distribution, and per-layer flow decomposition. Same seed → same
result, bit-for-bit.

---

*This is a working draft. Comments and corrections welcome.*
