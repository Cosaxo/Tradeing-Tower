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

## 9. Limitations

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

## 10. Conclusion

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
