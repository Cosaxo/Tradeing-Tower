# Hyperfloat

### *(formerly Trading Tower)*

### A Five-Tier Thread Stablecoin That Returns Float to the User

**Working draft · v0.6**

---

## Contents

1. [Introduction](#1-introduction) (incl. §1.4 multi-product replacement, §1.5 Tier 5 — wallet-share commitment auction)
2. [The Four-Layer Thread](#2-the-four-layer-thread)
3. [Layered Risk Architecture](#3-layered-risk-architecture)
4. [Auto-Mint and the Tier Ladder](#4-auto-mint-and-the-tier-ladder)
5. [The Trading Venue](#5-the-trading-venue-secondary-value-prop)
6. [Safety Analysis](#6-safety-analysis)
7. [Calibration](#7-calibration)
8. [Theoretical Extensions](#8-theoretical-extensions)
9. [Mathematical Foundations](#9-mathematical-foundations)
10. [Additional Thread Layers](#10-additional-thread-layers)
11. [Production Architecture](#11-production-architecture)
12. [Technology Stack](#12-technology-stack)
13. [Failure-Mode Taxonomy and Threat Model](#13-failure-mode-taxonomy-and-threat-model)
14. [Welfare and Equilibrium Analysis](#14-welfare-and-equilibrium-analysis)
15. [Competitive Landscape](#15-competitive-landscape)
16. [Tokenomics and Governance](#16-tokenomics-and-governance)
17. [Roadmap with Empirical Gates](#17-roadmap-with-empirical-gates)
18. [Open Research Questions](#18-open-research-questions)
19. [Worked Numerical Examples](#19-worked-numerical-examples)
20. [Formal Properties and Proof Sketches](#20-formal-properties-and-proof-sketches)
21. [Audit and Verification Checklist](#21-audit-and-verification-checklist)
22. [A Deeper Comparison with Ethena (USDe)](#22-a-deeper-comparison-with-ethena-usde)
23. [Limitations](#23-limitations)
24. [Conclusion](#24-conclusion)
- Appendix A — [Notation](#appendix-a--notation)
- Appendix B — [Implementation modules](#appendix-b--implementation-modules)
- Appendix C — [Reproducibility](#appendix-c--reproducibility)
- Appendix D — [Glossary](#appendix-d--glossary)

---

## Brand thesis

In the legacy financial system, every dollar that sits idle between
productive uses — *float* — is captured by an intermediary. Banks
earn the spread on checking-account float. Insurance companies
profit primarily from float (premium revenue between collection and
payout). Brokers earn float on cash balances and sell PFOF on top.
Stablecoin issuers earn ~5% on the reserves while holders earn 0%.
Gift-card issuers and merchants capture float on prepaid balances
and pocket forfeitures on expiry.

**Hyperfloat captures every one of these float locations and
returns the yield to the user.** Five tiers, each corresponding to
a real category of float in the legacy system:

| Float location | Currently captured by | Hyperfloat tier |
| :-- | :-- | :-- |
| Checking balances | Banks (earn spread) | **Tier 1** — T-bill yield |
| Insurance reserves | Insurance companies (premium float) | **Tier 2** — premium income |
| Brokerage cash | Brokers (float + PFOF) | **Tier 3** — B-book pool income |
| Stablecoin reserves | USDC / USDT issuers | **Tier 4** — FLOAT face yield |
| Gift-card / loyalty / category-spend captures | Merchants + card issuers | **Tier 5** — wallet-share commitment auction |

The four-layer thread of v0.5 captured tiers 1–4. Tier 5 — the
*wallet-share commitment auction* layer (Section 1.5 below) — is added
in v0.6.

The pitch in one sentence:

> *Hyperfloat — every float capture-mechanism the financial system uses against you, returned as yield.*

## Abstract

Hyperfloat is a financial protocol in which one dollar of user
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

### 1.2 The Hyperfloat thesis

The protocol's thesis is that capital efficiency can be improved
substantially without stacking risk, by stacking *uncorrelated yield
sources on the same capital*. Four roles, each producing yield from
a different mechanism:

| Layer | Yield source | Correlation to layer 1 |
| :--: | :-- | :-- |
| 1 | T-bill principal | — (baseline) |
| 2 | Insurance premium income from event-market sellers | low (idiosyncratic event risk) |
| 3 | B-book pool yield from underwriting unprofitable retail flow | low (cross-asset, cross-direction) |
| 4 | FLOAT optionality (stablecoin face usable as payment) | — (no yield, optionality) |

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
| Sustained FLOAT redemption pressure | 100% | +4.5% | +4.5% |
| Layer-3 zero-mean volatility | 100% | +7.3% | +1.5% |
| Layer-3 sustained losing streak | 100% | +2.2% | +1.5% |
| Layer-3 fat-tail catastrophe | 96% | +7.0% | −4.0% |

All values over 200 simulated days. Mean annualised yield ≈ 8.5%
across the original four scenarios; uplifted in B-book stress
scenarios because growth on the user's stake is asymmetric to
loss-with-reinsurance.

### 1.4 Value as a multi-product replacement

Hyperfloat is not "a yield product" or "a stablecoin" or "a
trading venue" individually. It is a candidate replacement for
the **entire retail consumer-finance stack**: checking, savings,
brokerage, and conservative bond-fund allocation, in one
product. This subsection makes that explicit.

#### 1.4.1 As a trading platform

The LAP auction (Section 5) is structurally better than every
existing retail trading venue along three independent axes:

**No spread, no commission, paid for the unpopular side.**
The auction matches bids at fixed prices via the geodesic
distribution; there is no market maker capturing a spread.
There are no commissions. The entropy weighting (§5.2)
*pays the user* a tip premium for taking the under-supplied
side of the book — the opposite of every existing venue,
which charges more for less liquid sides.

**Transparent A/B classifier instead of hidden B-book.**
The CFD industry's worst feature is that brokers run hidden
B-books against losing customers without disclosure. The
classifier (§5.3) makes this explicit, opt-in, and
compensated. Underwriters who want to absorb retail
loss-flow do so transparently; users see their own
classification and the gap to A. This isn't an incremental
UX improvement — it directly fixes the structural conflict
of interest in the $50B+ CFD industry.

**Concrete cost comparison** (round-trip cost on a $10,000
notional leveraged position):

| Venue | Spread | Commission | PFOF / hidden | Total cost |
| :-- | --: | --: | --: | --: |
| Plus500 (CFD) | $5–15 | $0 | hidden B-book | $5–15 + spread |
| Robinhood | $0 | $0 | ≈$3 (PFOF) | $3 |
| Interactive Brokers | minimal | $1–5 | $0 | $1–5 |
| dYdX | $0 | $5 | $0 | $5 |
| Hyperliquid | $0 | $3.5 | $0 | $3.5 |
| **Hyperfloat (popular side)** | $0 | $0 | $0 | **$0** |
| **Hyperfloat (unpopular side)** | $0 | $0 | $0 | **−$10 to −$50 (rebate)** |

The unpopular-side rebate flips the cost from positive to
negative. A retail trader who systematically takes
contrarian positions earns rebates instead of paying fees.

#### 1.4.2 As an investment object

The protocol delivers ≈8.5% annualised yield with empirically
bounded downside (Section 6). The risk-adjusted profile, if
the empirical safety claim holds at production scale, is
better than any existing retail investment.

**Sharpe ratio comparison**:

| Product | Annualised yield | Approx. std | Sharpe |
| :-- | --: | --: | --: |
| HYSA / T-bill | ~4% | ~0% | n/a |
| S&P 500 index fund | ~7% real | ~15% | ~0.5 |
| AGG (US Aggregate Bond) | ~3.5% | ~5% | ~0.3 |
| Yearn yvUSDC | ~5% | ~3% | ~1.0 |
| Ethena USDe (sUSDe) | ~10% | ~5% (regime-dependent) | ~1.0 |
| **Hyperfloat** (if safety claim holds) | **~8.5%** | **~3%** | **~2.7** |

A Sharpe of 2.7 is institutional-quant-fund territory. The
arithmetic comes from the four-layer thread's diversification
benefit: when yield sources are uncorrelated, the joint
distribution's standard deviation is much lower than any
single layer's.

**Spendability is a category change, not a feature.** An S&P
500 fund returns 7% real but is unspendable — to use it for
purchases you must sell, wait T+2 to settle, deal with
capital gains, then move cash. Hyperfloat's FLOAT face is
spendable directly. You're not choosing between *investing*
and *having spending money* — you have both in the same
dollar. The only existing comparable thing is a checking
account at 0% yield (or Apple Cash at 4%, or USDC at 0%).
**FLOAT at 8.5% with checking-account spendability is unique.**

**Behavioural realism**. ~80% of retail investors sell at the
bottom of equity drawdowns and lose to their own behaviour
rather than to the market. An index fund's 7% theoretical
return is what disciplined long-horizon investors achieve;
the typical retail investor's *realised* return is much
lower. Hyperfloat's bounded-downside profile (worst
observed −4% in stress) eliminates the behavioural-failure
mode. **For most retail investors, Hyperfloat's
empirically-bounded outcome is genuinely better than an
index fund's theoretical superior return.**

#### 1.4.3 As a stablecoin (and why it may avoid stablecoin regulation)

FLOAT is the protocol's stablecoin-shaped token: 1 FLOAT redeemable
for $1 of underlying collateral, freely transferable, usable
as a medium of exchange. But its **issuance structure is
materially different from centrally-issued stablecoins
(USDC, USDT, USDP)** in ways that matter for regulatory
classification.

**Centralised stablecoin model** (USDC, USDT):
- One legal entity issues the token.
- The issuer holds a reserve (T-bills, cash) backing all
  outstanding supply.
- Users redeem against the issuer's reserve.
- Squarely captured by stablecoin regulation
  (MiCA "e-money tokens" / "asset-referenced tokens";
  US: payment-stablecoin frameworks under STABLE,
  Lummis-Gillibrand).

**Algorithmic / overcollateralized model** (DAI, LUSD,
historically):
- No central issuer; the smart contract emits tokens.
- Each token backed by user-locked collateral, not a pool.
- User mints against their own deposit, redeems from their
  own deposit.
- Has historically navigated stablecoin regulation by being
  *structurally non-issued* — there's no issuer to license.

**Hyperfloat (FLOAT) model**:
- No central issuer; the smart contract emits FLOAT face.
- Each FLOAT face is backed by an *identifiable thread principal*
  belonging to the user who minted it.
- The user is, in effect, *issuing FLOAT to themselves* against
  their own collateral.
- The protocol is the rule-engine, not an issuer.

This places FLOAT structurally closer to DAI / LUSD than to USDC
/ USDT. Three properties strengthen the regulatory argument
beyond DAI's:

1. **Per-user collateral (not pooled reserves).** Unlike
   USDC where Circle holds a pooled reserve backing all
   supply, each FLOAT face is backed by *that specific user's*
   thread principal. There is no shared reserve the protocol
   maintains. The protocol cannot become insolvent in the
   way a fractional-reserve issuer can — the collateral is
   identifiable per-token.

2. **Higher-quality underlying collateral.** DAI is
   criticised because much of its backing is volatile crypto
   (ETH, USDC). FLOAT's principal is a **T-bill** — the safest
   form of dollar-denominated collateral that exists. From a
   regulatory perspective, this is *more* conservative than
   DAI, not less.

3. **Permissionless redemption.** A FLOAT holder can always
   redeem against their thread (subject to queue mechanics).
   There is no central party that can refuse redemption, no
   "issuer discretion." The redemption right is enforced by
   smart contract logic.

#### 1.4.3.1 The regulatory argument, stated carefully

We do not claim FLOAT is *exempt* from stablecoin regulation —
that determination depends on jurisdiction-specific
analysis we are not qualified to make. We argue that FLOAT has
**stronger structural arguments for being outside
stablecoin frameworks** than DAI or LUSD, because:

- FLOAT lacks a central issuer (unlike USDC, USDT, USDP).
- FLOAT's reserve isn't pooled — backing is per-token, not
  protocol-wide.
- FLOAT's underlying collateral is T-bill, structurally safer
  than crypto-collateralised stablecoins.
- The protocol's smart contracts are publishable as
  immutable code — no central party to hold liable.

Under the EU's **MiCA** framework, FLOAT may not qualify as
either an "e-money token" (EMT — requires single-fiat
backing and an authorised issuer) or an "asset-referenced
token" (ART — requires a basket of reference assets
maintained by an issuer). It plausibly falls outside both
categories as an "algorithmic non-issued claim token" —
conceptually closer to a fungible debt-position token than
a stablecoin in the regulatory sense.

Under proposed US frameworks (**STABLE Act**,
**Lummis-Gillibrand**), the focus is on "payment
stablecoins" with an issuer maintaining $1 fiat reserves
per token. FLOAT lacks an issuer entirely; the smart contract
mints and burns based on user-locked collateral. The
proposed legislation explicitly excludes
overcollateralized debt-position tokens of the DAI shape
from stablecoin classification in some drafts.

**Action implication**: a competent legal opinion from a
DeFi-experienced firm (recommended: Cooley, A&O Shearman,
Walkers) is the right next step before launching. The
opinion should specifically address whether FLOAT's structure
falls outside the relevant jurisdictional stablecoin
framework. The arguments above suggest a credible *yes*;
formal validation requires legal work.

If the legal analysis confirms this view, **FLOAT becomes a
yield-bearing spendable token without stablecoin
regulation overhead** — a position no centralised
stablecoin can occupy.

#### 1.4.4 Combined market positioning

The four use cases above each map onto a separate existing
$1B+ retail market:

| Replaces | Existing market size | FLOAT advantage |
| :-- | --: | :-- |
| Checking accounts | $1.5T+ US retail deposits | 8.5% yield on what's normally 0% |
| Savings accounts | $7T+ US savings | 8.5% beats HYSA 4–5% with comparable downside |
| Brokerage trading | $40B+ retail commission revenue | Zero commissions + rebates for unpopular sides |
| Conservative bond allocation | $5T+ in bond funds | 8.5% with bounded downside vs ~4% with rate-risk drawdowns |

Even capturing 0.1% of the combined market is $30B+ TVL.
This is not a yield protocol sized like Ethena ($5B); it is
a candidate consumer-finance category leader sized like
Robinhood ($25B equity) or Charles Schwab ($150B+).

The product's defensibility comes from the **integration**:
no competitor combines high yield + bounded downside +
spendability + transparent trading venue + per-user
collateral structure in a single financial product. Each
component individually exists somewhere; their integration
into one user experience does not.

### 1.5 Tier 5 — Purchase-intent float (the gift-card layer)

In the legacy financial system, gift cards, prepaid cards,
loyalty programs, and category-spend captures (Costco-style
memberships, retail subscriptions) represent a major float-capture
mechanism that hasn't been mentioned so far. The numbers are
large: the US gift-card market alone is ~$200B annual issuance
with ~$3B forfeited each year through expiry; loyalty programs
collectively capture tens of billions in float. In every case,
the merchant or card issuer holds the prepaid balance, earns
yield on it, and (often) keeps the entire balance if the user
doesn't spend it in time.

Hyperfloat's Tier 5 — added in v0.6 — captures this float layer
and returns it to the user. **Critically, sellers don't compete by
offering discounts or cashback** — they compete by **paying the
user cash directly** for committed wallet-share. This is the
existing customer-acquisition-cost spend that retailers already
make on marketing, redirected to the customer.

#### 1.5.1 Mechanism

The mechanic is a **category-level recurring-spend commitment
auction** with smart-contract escrow on the user's FLOAT face:

1. **User commits a spending budget for a category.** Specifies:
   - **Category** (e.g. groceries, gas, dining, software
     subscriptions).
   - **Budget per period** (e.g. $200/month).
   - **Number of periods** (e.g. 6 months → $1,200 total
     commitment).
2. **Eligible sellers bid for the commitment.** The bid is a
   **direct cash payment** the seller is willing to make to win
   the user's wallet-share. Examples: "$50 to get your $1,200
   grocery commitment", "$80", "$120". Sellers compete by raising
   the bid amount.
3. **User accepts the highest acceptable bid.** The smart contract
   atomically:
   - Transfers the bid amount of FLOAT from the seller to the user.
   - Locks the user's $1,200 of FLOAT face, designated as
     spendable only at this seller, only on this category, for the
     committed window.
4. **The locked FLOAT keeps earning yield.** Crucially, the locked
   FLOAT face is still backed by the user's underlying thread
   principal. The thread continues to earn from layers 1–3 (T-bill,
   insurance, B-book) on the unspent locked balance during the
   entire commitment window. The user's float is *captured by the
   user themselves*, not by the merchant.
5. **User shops normally over the period.** Each purchase at the
   seller (in the committed category) deducts from the locked
   amount. **No per-purchase discount mechanic** — the user pays
   normal prices at point-of-sale. The seller's "discount" was
   already paid upfront in the auction (step 3).
6. **End-of-window settlement.**
   - If fully spent: contract closes cleanly. User keeps the
     upfront bid payment + accumulated float yield.
   - If under-spent: user pays a small penalty (1–5% of unspent)
     to the seller as compensation for unfulfilled commitment.
     Remainder + float yield − penalty returns to the user's
     free FLOAT balance.

#### 1.5.2 Worked numerical example

Concrete walkthrough — user commits $200/month grocery spending
for 6 months (total $1,200 commitment):

**At commitment time**:
- Three grocery shops bid: ShopA $50, ShopB $75, ShopC $90.
- User accepts ShopC's $90 bid.
- Smart contract:
  - Pays $90 from ShopC to user's FLOAT wallet (immediate cash).
  - Locks $1,200 of user's FLOAT face for spending at ShopC,
    grocery category, 6-month window.

**Over 6 months**:
- User shops at ShopC normally; pays full prices at checkout.
- Each purchase deducts from the $1,200 lock.
- The unspent locked balance averages ~$600 over the period.
- Float yield on average locked balance: $600 × 8.5% × 0.5
  ≈ $25.50.

**End of period (assuming 100% spent)**:
- User received $90 upfront + $25.50 float yield = **$115.50 of
  benefit on $1,200 of grocery spending = 9.6% effective
  discount**.
- ShopC paid $90 = 7.5% of guaranteed $1,200 revenue, with
  zero customer-acquisition cost beyond that.

For comparison: typical retail customer acquisition costs are
5–15% of LTV (for the entire customer relationship). ShopC paid
7.5% for one 6-month commitment — competitive with their normal
marketing spend, with the bonus of guaranteed revenue, no
churn risk, and rich cohort data.

#### 1.5.3 Why it's a Pareto improvement

**For the user**:
- Direct cash payment from the auction (~$50–$200 typical for
  $1,000–$3,000 commitments).
- Float yield on committed-but-unspent money during the period.
- Single auction step → multiple shops compete for them.
- Flexibility to re-auction at the end of each commitment window.
- Spending behaviour is normal — no per-purchase coupons or
  loyalty cards required.

**For the seller**:
- *Predictable revenue* — fundamental change in retail economics.
- *Marketing-cost-free customer acquisition* — they pay the
  customer directly instead of advertising agencies / ad
  platforms.
- *Wallet-share lock-in* for the duration of the commitment.
- *Cohort spending data* — they know what this customer commits
  to and can plan inventory accordingly.

**For the protocol**:
- A new float-capture layer, adding to the existing four.
- Transaction volume from each commitment auction (potential
  protocol fee).
- Network effects: more sellers attract more users (more bid
  competition); more users attract more sellers (more
  commitment volume).

#### 1.5.4 Comparison with legacy alternatives

| Mechanism | User float yield | Direct cash to user | Lock-in | Flexibility |
| :-- | :--: | :--: | :--: | :--: |
| Gift card | 0% | $0 | yes — to one merchant | none — full forfeit on expiry |
| Pre-paid card | 0% | $0 | yes — multi-merchant | low — high fees, expiry forfeit |
| Costco membership | 0% | -$60/yr (user pays) | yes (1 merchant) | annual renewal |
| Subscribe & Save | 0% | $0 (per-item discount) | per-item | moderate |
| Loyalty program | 0% | rebate after-the-fact | none | low |
| **Hyperfloat Tier 5** | **~8.5%** | **direct upfront bid (3–10% of commitment)** | **per category, per period** | **re-auction every period** |

#### 1.5.5 Risk profile

- **Smart-contract custody**: same risk surface as the underlying
  thread (auditable, formally verifiable).
- **Seller-bid-funding risk**: the seller must have bid amount
  available at auction acceptance. Smart contract requires
  upfront escrow before the lock activates.
- **Seller-default risk** (seller stops accepting purchases at
  the agreed terms): handled via reputation system + small
  penalty on seller side if they refuse purchases that fall
  within commitment terms.
- **User-default risk** (user under-spends): bounded by the
  end-of-period penalty.
- **Category-mismatch fraud** (user tries to spend on
  non-category items): handled via merchant integration + line-
  item categorisation at point-of-sale, similar to how
  category-restricted gift cards work today.

#### 1.5.6 Compatibility with the existing thread

Tier 5 is purely additive — it does not modify layers 1–4 in any
way. The user's thread principal stays in place, still earning
T-bill + insurance + B-book yield. The commitment mechanic
attaches a *spending designation* (category + seller + window)
to a portion of FLOAT face during the lock period. When the user
shops at the committed seller, FLOAT transfers via the standard
redemption path. When the period ends, any unspent FLOAT
returns to free balance.

The existing damage / growth / lockstep invariants are unchanged.
The harness can be extended trivially to model Tier-5 commitment
cycles as part of stress testing.

#### 1.5.7 Adoption path

Tier 5 doesn't require universal merchant adoption to be valuable.
Likely first sellers (where committed-demand visibility is most
valuable):

- **Subscription services**: SaaS, streaming, gym memberships —
  already have monthly-spend mental model.
- **Grocery / household**: high-frequency, predictable category
  with strong margins on customer LTV.
- **Gas / fuel**: utility-grade spending where shops compete on
  price already.
- **Restaurants and dining**: category with dedicated wallet-share
  budgets.
- **Creator subscriptions / patron commitments** — natively
  on-chain, simplest first integration.
- **Then expanding to physical retail** through merchant
  integrations (Shopify-style plug-ins, point-of-sale partners,
  category APIs from existing payment processors).

The bid-side liquidity (sellers willing to pay for commitments)
bootstraps from sellers who already have high CAC — every dollar
they normally spend on Google/Facebook ads can instead be paid
directly to the customer who commits. The user-side liquidity
bootstraps from existing FLOAT holders who already have
predictable category spending (groceries, gas, subscriptions) —
they're committing money they'd spend anyway and earning a bid
payment + float yield on top.
- **Travel and hospitality**: highly time-sensitive inventory,
  significant existing escrow / deposit norms (hotels, flights).
- **Digital goods**: software licences, subscriptions, gaming items.
  Zero-friction delivery makes oracle-confirmation easy.
- **Then expanding to physical retail** through merchant
  integrations (Shopify-shaped plug-ins, point-of-sale partners).

The protocol's bid-side liquidity (i.e., users wanting to commit
purchase intents) bootstraps from existing FLOAT minters. The
sell-side liquidity bootstraps from token-incentive emissions to
early sellers — same pattern as Curve's CRV emissions to LPs.

---

## 2. The Four-Layer Thread

### 2.1 Definition

A *thread* is a record of the form

$$
T = (\text{owner}, \, P, \, F, \, \mathbf{w}, \, \tau_0)
$$

where
- $P \in \mathbb{R}_{\geq 0}$ is the *principal* (layer 1, T-bill),
- $F \in \mathbb{R}_{\geq 0}$ is the *outstanding FLOAT face* (layer 4),
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
6. Mints $X$ FLOAT into the user's wallet (so $F = X$ at $\tau_0$).

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

Layer-1, 2, 3 fatten by $G$; layer 4 (FLOAT face) is intentionally
non-elastic. Gains accumulate as a *buffer* $P - F \geq 0$, which
absorbs subsequent damage before FLOAT face starts shrinking.

### 2.4 Buffer asymmetry

The asymmetry $G \to P, F$ unchanged versus $L \to P, F$ both
shrink (when $L$ exceeds the buffer) is a deliberate design choice
that gives the protocol a preferred direction:

- FLOAT supply only expands on a deliberate mint event, never from
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
claims that all default in stress. Hyperfloat is structurally
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
| 4 | FLOAT mint (full thread) | layer-3 role is *passive* B-book stake, not active LAP |

Tier 3 enforces *diversified, hedged* allocation as a hard gate
(`evaluateTier3Gate` in `lib/ltv.js`). Tier 4 is per-thread
mutually exclusive with active LAP trading: capital you've minted
into FLOAT is locked as a passive B-book underwriter; capital you
haven't minted is free to actively trade.

### 4.2 Easy mode and minting irreversibility

The retail user interacts with one button: *Convert $X to FLOAT*.
This auto-runs the entire ladder in the safe configuration —
allocate evenly across reinsurance-covered markets, buy
reinsurance, deposit B-book stake, mint FLOAT.

Minting is *deliberately reversal-resistant*:

- Standard redemption is capped at 10% of FLOAT supply per
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
T-bill, an insurance stake, a B-book stake, a FLOAT face, *and* a
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
\Delta F = \gamma \cdot G \quad\text{(fraction of gain that auto-mints additional FLOAT)}
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
FLOAT face is already stable-token-shaped, but the *underlying
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

A plausible Hyperfloat v2 thread:

| # | Layer | Yield (typical) | Stress correlation to layer 1 |
| :--: | :-- | :--: | :--: |
| 1 | Multi-sovereign T-bill basket (60%) + MMF (20%) + commercial paper (20%) | 4.0% | — |
| 2 | Insurance-seller stakes across 16 standard events | 3.5% net | low |
| 3 | B-book pool stake (passive underwriter) | 2.5% net | low |
| 4 | FLOAT face (stablecoin optionality) | — | n/a |
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

## 13. Failure-Mode Taxonomy and Threat Model

A protocol's safety claim is only as strong as its failure-mode
analysis. This section catalogues the ways Hyperfloat can
break, organised by failure category, with detection signals,
mitigations, and recovery paths for each.

### 13.1 Mechanism failures

These are bugs or design flaws in the protocol itself.

**Lockstep invariant violation.** Damage applied to one layer
without propagating to the others. *Detection*: per-tick
runtime check that for every active thread,
$\sum_i \text{layer}_i$ is consistent. *Mitigation*: every
damage path goes through `damageThread`, which returns deltas
the loop must apply. *Recovery*: protocol auto-pauses on
violation; manual state reconciliation.

**Conservation invariant violation.** Net cash flow per tick
deviates from $E(t)$ (T-bill external inflow). *Detection*:
`conservation.test.js` runs on every commit; runtime check
on settlement service. *Mitigation*: every cash flow has an
explicit counterparty pair (in/out matched). *Recovery*:
auto-pause + audit.

**Epoch-separation violation.** Insurance and LAP damage fire
on the same tick. *Detection*: structural — coprime strides
prevent it. *Mitigation*: `INSURANCE_STRIDE = 2` constant
gates the insurance settlement; LAP runs on the off-stride.
*Recovery*: not needed under current design; was a manual
discipline pre-Tier-1.0.

**Insurance/B-book reinsurance double-payment.** Same loss
triggers payouts from both reinsurance products. *Detection*:
the harness tracks per-tick attribution; double-payment shows
as inflated joint outcome. *Mitigation*: the B-book reinsurance
takes per-tick B-book P&L explicitly, *not* pool stake — it
ignores insurance-driven thread damage. *Recovery*: this was a
real bug in development, fixed by separating the data feeds.

### 13.2 Calibration failures

Parameters tuned wrong such that the safety claim doesn't hold
empirically.

**Premium rate misset.** Base rates either too high (kills
yield, drives users out) or too low (sellers underpaid, leave).
*Detection*: harness joint-outcome metric drops below the
acceptance threshold. *Mitigation*: parameter changes gated on
harness validation before DAO ratification. *Recovery*: revert
the parameter change.

**Rate-floor misset.** MIN clamp pinned at sub-T-bill, prevents
oversupplied markets from clearing. *Detection*: sustained
seller pile-up, low premium rates. *Mitigation*: floor relaxed
to 0.01× base in Sprint 4.5b. *Recovery*: parameter change.

**Reinsurance face misset.** Auto-mint face fraction either
under-covers (user takes uncovered loss) or over-pays (dead
premium). *Detection*: per-tick reinsurance-net stays negative
with no tail-risk realisation; or, claim losses exceed paid
amounts in stress. *Mitigation*: face = $\sum c_k$ for full
coverage at minimum cost. *Recovery*: parameter change.

**Stride misset.** `INSURANCE_STRIDE` set to 1 (back to
overlapping). *Detection*: epoch-separation invariant test
fails. *Mitigation*: protocol-level constant; DAO-gated
change requires harness re-validation.

### 13.3 Adversarial failures

Attacks by malicious actors.

**Sybil attacks.** A user creates many identities to evade the
whale exception or coordinate against the pool. *Detection*:
classifier monitoring for anomalous inter-account correlation
(same source funds, same trade timing, same withdrawal patterns).
*Mitigation*: KYC/AML on identity creation; bind unique identity
to deposits. *Recovery*: freeze affected accounts; clawback if
provable.

**Oracle manipulation.** Attacker corrupts a price feed to
trigger a false insurance event. *Detection*: cross-source
oracle aggregation; staleness detection; statistical
divergence alerts. *Mitigation*: median-of-N from independent
oracle networks; settlement waits for consensus. *Recovery*:
disputed events resolved via UMA-style escalation; payouts
held in escrow during dispute.

**Front-running insurance triggers.** Attacker monitors
event probabilities and posts insurance just before a trigger.
*Detection*: deposit-then-immediately-trigger patterns.
*Mitigation*: insurance lockup (200 ticks) prevents this.
*Recovery*: not needed if lockup holds.

**Coordinated B-book attack.** Multiple B-classified users
coordinate the same trade to drain the pool. *Detection*:
classifier monitoring for anomalous correlation in B-flow;
pool drawdown rate vs. predicted. *Mitigation*: per-user
notional cap inside the pool; regime-aware capacity (lower in
stress); B-book reinsurance pool absorbs the loss.
*Recovery*: pool circuit-breaker pauses new B-book contracts;
existing positions settle normally.

**Governance attack.** Attacker accumulates governance tokens
to push a malicious parameter change. *Detection*: governance
proposal review; concentration metrics on token holdings.
*Mitigation*: timelock on parameter changes; harness validation
gate; multi-sig veto for emergencies. *Recovery*: emergency
veto; community fork if necessary.

### 13.4 Correlated-stress failures

Multiple layers fail simultaneously despite design intent.

**Stress-correlation surprise.** A previously-uncorrelated layer
becomes correlated in stress (e.g., catastrophe bonds become
correlated with credit during a global pandemic). *Detection*:
cross-layer realised correlation matrix monitored in
real-time; flag when stress correlation > planned. *Mitigation*:
each layer's reinsurance acts independently; user holds layered
hedges. *Recovery*: re-calibrate correlation assumptions;
potentially restrict the offending layer.

**Cascade failure.** Layer-2 trigger damages thread, which
damages layer-3 stake, which triggers a B-book classifier shift,
which causes more layer-3 losses. *Detection*: per-thread
feedback metric; cascade-rate alarm. *Mitigation*: epoch
separation breaks immediate feedback loops; reinsurance breaks
the wealth-loss cascade. *Recovery*: protocol auto-pause if
cascade-rate exceeds threshold.

**Fat-tail event beyond stop-loss.** A loss exceeds the
reinsurance exhaustion. The user eats the difference.
*Detection*: per-event severity ranking; flag events above
historical max. *Mitigation*: this is the *intentional*
boundary — the protocol promises bounded protection, not
infinite. The exhaustion fraction is a calibrated trade-off
between premium cost and worst-case coverage. *Recovery*:
none — the user knew the deductible.

### 13.5 Operational failures

Infrastructure-level breaks.

**Smart contract upgrade bug.** A bad upgrade introduces a
state-machine flaw. *Detection*: continuous invariant tests
run against post-upgrade state; user-facing bug reports.
*Mitigation*: timelock on upgrades; multi-stage audit;
canary deployments. *Recovery*: emergency multi-sig downgrade
or guarded upgrade-and-fix.

**Settlement service downtime.** The off-chain orchestrator
goes down; medium ticks stop processing. *Detection*: tick
liveness monitor. *Mitigation*: stateless replicated service;
state is on-chain, so any replica can resume. *Recovery*:
warm replica takes over; missed ticks roll into the next
processed tick.

**Oracle network downtime.** Price feeds become stale.
*Detection*: staleness threshold per feed. *Mitigation*:
multi-source aggregation; protocol auto-pauses settlement on
sustained staleness. *Recovery*: oracle resumption +
catch-up settlement.

**Custody key compromise.** An attacker gets a custody key.
*Detection*: anomalous transaction patterns; KYT
(know-your-transaction) screening. *Mitigation*: hardware
security modules; multi-sig with geographic distribution;
withdrawal limits per signing event. *Recovery*: key
rotation; insurance from custody provider.

### 13.6 Liquidity failures

Mass user behaviour breaking the protocol.

**Run on FLOAT (mass redemption).** All FLOAT holders redeem at
once. *Detection*: redemption queue depth metric.
*Mitigation*: 10% standard cap per cycle bounds the rate;
express redemptions cost 5% (deters panic); user mints
cannot be reversed faster than the 10% cap. *Recovery*: the
redemption queue clears on its own; no protocol intervention
needed. *Trade-off*: redeemers wait their turn — they receive
their dollars over multiple cycles, not instantly.

**Reinsurance pool drain.** Reinsurance sellers withdraw en
masse after a major payout. *Detection*: seller-side
withdrawal rate; pool capacity utilisation. *Mitigation*:
200-tick lockup; staggered withdrawal release; potential
counter-cyclical bonus to retain capital. *Recovery*: the
lockup gives time for replacement capital to enter; if
capacity drops below threshold, protocol auto-pauses new
mints (existing positions continue).

**B-book pool drain (without reinsurance).** Coordinated
retail wins drain the pool faster than stake replenishes.
*Detection*: pool-NAV decline rate; classifier divergence.
*Mitigation*: B-book reinsurance pool covers the
attachment-to-exhaustion layer; regime-aware capacity caps;
per-user notional cap. *Recovery*: same as reinsurance pool
drain — circuit breaker, lockup, replenishment.

### 13.7 Regulatory failures

Outside the protocol's direct control.

**Jurisdiction ban.** A regulator bans the protocol's
operation in a major jurisdiction. *Detection*: legal
monitoring. *Mitigation*: jurisdiction-aware routing at the
KYC layer; users in banned jurisdictions cannot mint;
existing positions are honoured (redemption always works).
*Recovery*: re-domicile; legal challenge; or accept
geographic restriction.

**Reclassification of FLOAT as a security.** Regulator
reclassifies the stablecoin under securities law.
*Detection*: legal monitoring. *Mitigation*: pre-emptive
legal opinions; structuring FLOAT to satisfy multiple
classifications (e-money, stablecoin, security if needed).
*Recovery*: legal restructuring; potentially separate the FLOAT
issuance from the protocol entity.

**Sanctions / KYC mandate change.** New AML rules add
verification requirements. *Detection*: regulatory
monitoring. *Mitigation*: KYC integration is modular;
upgradeable. *Recovery*: integrate new compliance vendor;
re-verify affected users.

### 13.8 Threat model summary

The protocol is most exposed to:

1. **Adversarial coordination** at scale (Sybil + B-book
   coordination + governance capture). The current binary
   classifier and the small number of test users limit
   exposure today; production needs hardened detection.
2. **Stress correlation surprises** in newly-added thread
   layers. The harness's role as acceptance gate (Section
   10.5) is the key mitigation.
3. **Oracle manipulation** on event triggers. Robust oracle
   network design is non-negotiable for production.
4. **Operational and regulatory failures** are real but
   conventional — handled by standard ops + compliance
   playbooks.

The protocol is *least* exposed to:

1. **Conservation / lockstep bugs** — exhaustively tested
   and structurally enforced.
2. **Mass redemption runs** — bounded by the standard cap;
   protocol cannot be drained faster than the cap allows.
3. **Single-counterparty failure** — by design, no single
   counterparty is load-bearing.

---

## 14. Welfare and Equilibrium Analysis

A protocol is rational only if every participant has positive
expected economic surplus from participating. This section
walks through each role and shows the equilibrium conditions
under which they rationally engage.

### 14.1 The FLOAT minter (retail user)

**Expected surplus**:
$\mu_{\text{T-bill}} + \mu_{\text{insurance net}} + \mu_{\text{B-book net}} - \mu_{\text{deductibles}}$.

In current calibration, this is approximately
$4\% + 3\% + 2.5\% - \text{deductibles}$ ≈ 8.5–9% annualised
in calm conditions; bounded downside in stress.

**Why rational**: dominates HYSA (4%) and most retail-grade
yield products. The thread mechanic provides risk-adjusted
return that's competitive with much riskier alternatives
(perpetual yield farms, leveraged ETFs).

**Equilibrium condition**: protocol's net yield > opportunity
cost (HYSA, T-bill, alternative yield products at
comparable risk). Currently met.

### 14.2 The insurance buyer (synthetic counterparty in harness; real users in production)

**Expected surplus**: $E[\text{coverage payout}] - \text{premium paid}$.
For a sophisticated buyer with accurate event probability
estimates, this nets to approximately zero in equilibrium —
they're buying insurance for risk-shifting, not for expected
profit. The premium they pay reflects the protocol's
self-correcting price.

**Why rational**: real-world institutional users buy
insurance to hedge specific exposures (e.g., a crypto fund
buys BTC-crash insurance to bound their drawdown). The
expected NPV is negative, but the hedging value is real.

**Equilibrium condition**: insurance premium ≤ buyer's
willingness to pay for the risk-shifting service. Set by
the supply/demand balance via $r = r_0 \sqrt{C/S}$.

### 14.3 The reinsurance seller

**Expected surplus**: $\text{premium income} \cdot (1 - \text{expected loss ratio}) - \text{capital opportunity cost}$.

For a typical 200-tick lockup at 3.65% annualised premium
with full reinsurance coverage, the seller earns roughly
2–3% annualised on locked capital after expected losses,
assuming realistic event probabilities. This is below T-bill
in calm conditions — sellers participate because:
- The premium income is *uncorrelated* with their other
  portfolio holdings (insurance event yield diversifies
  across portfolio).
- Stress-correlated yield (premiums rise during high
  realised stress) provides a counter-cyclical kicker.
- For institutional capital, the diversification benefit
  is the primary attractant.

**Equilibrium condition**: reinsurance premium ≥
opportunity cost of locked capital + expected loss + risk
premium. The protocol's current calibration may be tight
on this; a stress-bonus mechanism (Section 8.3) would
ensure equilibrium across regimes.

### 14.4 The B-book underwriter (voluntary)

**Expected surplus**: pool's tip income + losing-trader P&L
minus winning-trader P&L. Historically, retail-classified
flow loses ~70–85% of the time (this is well-documented in
CFD industry data), so B-book underwriting is positive-EV
for the pool over time. Subject to drawdowns when retail is
right.

**Why rational**: the same business model as a regulated
B-book CFD broker (Plus500 reports ~60–70% of customers
losing money), but transparently structured. Underwriters
explicitly sign up to absorb losing-trader flow.

**Equilibrium condition**: pool yield ≥ opportunity cost +
risk premium for absorbing tail risk. The B-book reinsurance
hedge bounds the tail; the pool's yield comes from
sustained slight edge.

### 14.5 Surplus distribution under stress

**Calm regime**: every role earns approximately their
expected surplus. Total surplus comes from T-bill yield
(external inflow) plus the *trade-off compensation* the
counterparties pay to the user (premium for risk-shifting).

**Stress regime**: surplus shifts. The FLOAT minter's outcome
becomes more variable; insurance buyers' expected
realisation rises; reinsurance sellers' realised loss
rises; B-book underwriters either gain (most retail loses)
or take a coordinated hit (covered by reinsurance).

The protocol's empirical safety claim is precisely that the
FLOAT minter's *worst-case* surplus stays positive across
stress regimes, even if their *median* surplus drops. The
trade-off: in stress, the minter accepts a lower realised
yield, but never a negative one (with the harness's 96%+
empirical bound).

### 14.6 Why the protocol is socially welfare-improving

Compared to alternatives:

- **Vs. HYSA / T-bill**: the user gets equivalent downside
  protection plus a meaningful yield kicker. Welfare-positive.
- **Vs. CFD broker B-booking**: B-book exposure is *opt-in
  and transparent* rather than hidden. The CFD broker's
  conflict of interest is replaced with a market mechanism
  where underwriters explicitly accept the role. The CFD
  customer's worst-case has historically been ~95% drawdown;
  the FLOAT minter's worst-case is bounded at the deductible.
- **Vs. DeFi yield aggregators**: Hyperfloat's reinsurance
  layer provides explicit downside protection that
  yield-aggregators don't. Welfare-positive for the user;
  welfare-negative for the systemic-risk-loving
  aggregator-yield-chaser.

The protocol's existence creates *new* welfare via the
diversification benefit of stacking uncorrelated yields
on the same capital. This is the fundamental social-welfare
case for the design.

---

## 15. Competitive Landscape

Hyperfloat sits at the intersection of three established
markets. This section positions it relative to the most
relevant existing protocols.

### 15.1 Stablecoin protocols

| Protocol | Collateral | Yield | Distinguishing property |
| :-- | :-- | :--: | :-- |
| **USDC / USDT** | T-bills + cash | 0% (issuer keeps yield) | Centralised, regulated |
| **DAI (Maker)** | Crypto + RWA | ~5% (sDAI) | Overcollateralised crypto |
| **USDe (Ethena)** | ETH + perp short basis | ~10% | Delta-neutral basis trade |
| **USD0 (Usual)** | Tokenised T-bills (RWA) | ~4% | Pure RWA backing |
| **Hyperfloat FLOAT** | Four-layer thread | ~9% | One $ in 4 uncorrelated roles |

Closest in yield: **USDe** at ~10% via basis trade. Closest
in safety positioning: **USD0** with RWA backing. Trading
Tower is unique in *deriving yield from the collateral
playing multiple roles simultaneously* rather than from a
single mechanism (basis trade, RWA, or crypto leverage).

### 15.2 Insurance protocols

| Protocol | Coverage scope | Underwriter incentive | Distinguishing property |
| :-- | :-- | :-- | :-- |
| **Nexus Mutual** | Smart-contract failure | NXM token rewards | Mutual-assurance model |
| **InsurAce** | Multi-protocol coverage | Premium income | Cross-chain |
| **Solv** | Yield protection | Embedded in product | Vault-style |
| **Hyperfloat** | Per-event protocol-defined risks | Premium + thread yield | Integrated with stablecoin |

Insurance protocols traditionally suffer from **underwriter
attrition** — sellers leave during high-loss regimes,
breaking coverage exactly when it's needed. Hyperfloat
mitigates this by:
- Reinsurance lockup (200 ticks).
- Counter-cyclical yield via the stress-correlation
  mechanism (Section 8.3, future).
- Underwriter capital being *part of a larger thread*, not
  standalone — the dollar isn't only doing insurance, so
  attrition is lower.

### 15.3 Leveraged-trading protocols

| Protocol | Model | Liquidity | Distinguishing property |
| :-- | :-- | :-- | :-- |
| **dYdX v4** | CLOB on Cosmos appchain | $1B+ TVL | Order book |
| **Hyperliquid** | CLOB on custom L1 | $5B+ daily volume | Performance |
| **GMX** | Trader-vs-pool (GLP) | $500M+ TVL | Pool absorbs trader P&L |
| **Plus500 / IG (CFD)** | Hidden B-book | Centralised | Regulated retail |
| **Hyperfloat (LAP)** | Geodesic auction with entropy weights | Pre-launch | Transparent A/B classifier; minority-side rebate |

GMX's GLP model is the closest analogue to Hyperfloat's
B-book pool mechanic: passive LPs underwrite trader losses.
The differences:
- GMX's GLP has no equivalent to the four-layer thread —
  LPs are exposed only to the trading P&L.
- Hyperfloat's classifier is transparent; GMX has no
  per-user classification.
- The minority-side entropy rebate is unique: it
  structurally pays users to take the unpopular side,
  improving book balance.

### 15.4 Yield aggregators

| Protocol | Yield source | Risk model | Distinguishing property |
| :-- | :-- | :-- | :-- |
| **Yearn** | Strategy rotation across DeFi | Market | Vault aggregation |
| **Pendle** | Yield tokenisation / fixed rate | Term | PT/YT split |
| **Spark / sDAI** | Maker DSR | Conservative | Maker-backed |
| **Hyperfloat** | Multi-role yield stacking | Layered | Reinsurance-protected |

Yield aggregators chain yields *sequentially* (deposit in A,
A's yield deposits in B, etc.) — risk compounds. Trading
Tower stacks yields *in parallel* on the same dollar — risk
is bounded by the lowest-correlated layer.

### 15.5 What Hyperfloat uniquely brings

1. **Four-layer thread**: a single primitive that produces
   four uncorrelated yields with lockstep solvency
   accounting. No competitor has this.
2. **Joint-outcome safety claim**: empirically verified
   across stress scenarios. Most competitors verify only
   per-product safety; Hyperfloat verifies
   user-level wealth.
3. **Transparent A/B classifier**: directly addresses the
   moral failing of CFD B-book trading. No competitor
   exposes this.
4. **Minority-side rebate via entropy**: structural fix
   to imbalanced order books.
5. **Layered reinsurance** (insurance + B-book) covering
   each risk surface independently.

What's *not* unique:
- Stablecoin issuance (many protocols).
- Insurance markets (Nexus, InsurAce, etc.).
- Leverage trading (dYdX, Hyperliquid, GMX, etc.).
- T-bill-backed stable yield (USD0, USDC's BUIDL).

The protocol's defensibility rests on the *integration*
rather than any single component. The integration's hardest
property to copy is the empirical safety claim — that takes
months of harness work to reproduce, and the harness itself
becomes a competitive moat.

---

## 16. Tokenomics and Governance

This section sketches a token-economic structure for a
production deployment. It is *not* finalised — different
launch strategies (institutional-first vs. retail-first,
permissionless vs. permissioned) imply different token
designs.

### 16.1 FLOAT supply mechanics

FLOAT is the protocol's stablecoin. Supply is governed
mechanically by mint and redemption events:

- **Mint**: 1 FLOAT created per $1 of free margin committed
  to a thread. Supply increases.
- **Standard redemption**: FLOAT face shrinks by the redeemed
  amount; user receives dollars proportional to thread
  principal. Supply decreases.
- **Express redemption**: same with 5% penalty routed to
  reinsurance sellers. Supply decreases.
- **Solvency clawback**: FLOAT face exceeds backing principal
  → clawback from wallet balance + soft debt.

There is **no protocol-controlled mint or burn** of FLOAT.
The supply is a deterministic function of user actions and
solvency state.

### 16.2 Optional governance token (TWR)

A separate governance token, tentatively named TWR, would
control protocol parameters. Two designs are possible:

**(a) No governance token.** Parameters are immutable at
launch. Changes require coordinated consensus among
participants (protocol fork, social signal). Maximally
conservative; minimum governance attack surface;
inflexible.

**(b) Governance token with timelock.** TWR holders propose
and vote on parameter changes. Each proposal must pass:
1. Voting threshold (e.g., 4% TWR participation, 60%
   approval).
2. Harness validation gate — the proposed parameter set
   must pass `npm run stress` with $\Pr(\text{joint} \geq 0)$
   above the floor across all scenarios.
3. Timelock (7 days) before activation.

(b) is more standard for DeFi protocols. The
harness-validation gate is unusual — it makes empirical
verification a hard prerequisite for any change, which
materially limits attack vectors compared to standard DAO
governance.

### 16.3 Governance scope

What TWR holders should and shouldn't control:

**In scope** (parameters with defined safe ranges):
- Premium rates (`BASE_PREMIUM_RATE`,
  `REINSURANCE_BASE_RATE`)
- Lockup periods
- Reinsurance face fractions
- Stride values
- Risk monitor thresholds
- Treasury allocations

**Out of scope** (load-bearing invariants):
- The lockstep damage propagation
- The conservation invariants
- The four-layer thread structure
- Adding new layers (requires a protocol upgrade, not a
  parameter change)

### 16.4 Treasury

The protocol accumulates revenue from:
- Express redemption penalties (5% of expressed amount).
- A small fraction of premium income (say, 2%) skimmed
  into the treasury — calibrated to be invisible at user
  level but meaningful at protocol scale.
- Trading fees (if any) on the LAP auction.

Treasury uses:
- Bug bounties.
- Audit fees.
- Counter-cyclical reinsurance subsidies during stress.
- Governance distribution (if TWR exists).
- Protocol development.

### 16.5 What about FLOAT yield to holders?

A common question: why doesn't FLOAT pay yield to holders the
way Ethena's USDe does (via sUSDe)?

The answer is that FLOAT's yield *already accrues to the
minter via the thread*. A separate sTT-style token would
double-count yield. A holder who wants the yield should
either:
- Hold FLOAT and the underlying thread (i.e., be the minter
  themselves), or
- Buy FLOAT in secondary, knowing they're holding a stable
  unit-of-account that doesn't yield (like a regular
  stablecoin).

This separation is intentional — it preserves FLOAT's role as
*money* (transactional, payments) while keeping yield with
the user who provided the collateral.

---

## 17. Roadmap with Empirical Gates

The protocol moves through phases, each gated by an
empirical or regulatory milestone. The harness — extended
phase-by-phase to model new conditions — is the canonical
acceptance test.

### Phase 0 — Research artifact (current)

**Status**: complete.

**Gates passed**:
- Conservation invariants tested on every commit (364
  tests).
- $\Pr(\text{joint outcome} \geq 0) = 100\%$ in 6 / 7
  stress scenarios; 96% in BBOOK_TAIL_EVENT.
- Multi-user demo via `BroadcastChannel`.
- Calibration validated empirically (TBILL_RATE,
  BASE_PREMIUM_RATE, REINSURANCE_BASE_RATE,
  BBOOK_REINS_BASE_RATE).
- B-book reinsurance pool restoring layer-3 safety claim.

**Deliverables**: working simulator, whitepaper v0.2,
roadmap.

### Phase 1 — Institutional pilot

**Targets**: < 100 users, single jurisdiction (Switzerland
or Singapore), TVL < $10M.

**Gates required**:
- Two independent smart-contract audits passed.
- Real-historical-data replay (Tier 1.4) added to harness;
  $\Pr(\text{joint} \geq 0)$ verified against COVID-March
  2020, August 2024 yen-carry, and one credit-stress event.
- Backend service architecture (Section 11) deployed.
- KYC integration live for the chosen jurisdiction.
- Insurance / e-money licence in target jurisdiction.
- 3-month testnet bug-bounty program with no critical
  findings.
- Manual oversight + circuit breaker operational.

**Headcount**: ~10 (engineers + ops + compliance).
**Budget**: ~$3M.
**Timeline**: 9–12 months from Phase 0.

### Phase 2 — Institutional scale

**Targets**: < 10k users, multi-jurisdiction (3+),
TVL < $500M.

**Gates required**:
- Phase-1 stability (no critical incidents for 6 months).
- Capacity audit at production scale (Section 9.6).
- Stress-bonus mechanism validated empirically (after
  observing seller-flight failure modes in Phase 1).
- Adversarial-coordination defenses validated against
  red-team exercises.
- Regulatory framework for multi-jurisdiction routing.

**Headcount**: ~25.
**Budget**: ~$5M.
**Timeline**: Phase 1 + 12 months.

### Phase 3 — Retail expansion

**Targets**: 100k+ users, full Easy mode public, TVL
$1B+.

**Gates required**:
- Retail-grade compliance framework (per-jurisdiction).
- Mobile app live.
- Risk visualisation in Easy mode (median, p5, p95
  outcomes shown to users).
- Customer-protection regulatory sign-off in target
  jurisdictions.
- Insurance reserve fund established at protocol level.

**Headcount**: ~50.
**Budget**: ~$10M.
**Timeline**: Phase 2 + 18 months.

### Phase 4 — Extended layers (5+)

**Targets**: catastrophe-bond, weather-derivative, and
mortality-underwriting layers added.

**Gates required**:
- Each new layer passes the harness acceptance gate
  (Section 10.5) — adding it does not worsen
  $\Pr(\text{joint} \geq 0)$ in any existing scenario.
- Real underwriting partnerships (Munich Re, Swiss Re,
  or equivalent) for off-chain risk capacity.
- Oracle network for parametric event triggers (NWS,
  USGS, weather data).

**Timeline**: Phase 3 + 12–24 months per layer added.

### Empirical-gate principle

Every transition between phases requires the harness
demonstrating that the safety claim holds under conditions
representative of the next phase. The empirical evidence
*is* the gate — not protocol-team consensus, not external
opinion, not subjective judgement. This builds in a
self-correcting mechanism: if the protocol's behaviour at
production scale diverges from its testnet behaviour,
deployment doesn't proceed until the divergence is
resolved.

---

## 18. Open Research Questions

This section documents what we don't know, in the spirit of
inviting external research.

### 18.1 Optimal calibration

The current parameters were tuned empirically against the
harness, not derived from first principles. Open questions:

- What's the optimal value of `BBOOK_REINS_ATTACHMENT_FRAC`
  (currently 0.10) as a function of expected B-book
  volatility? A formal Pareto analysis of premium cost vs.
  worst-case-coverage would settle this.
- How should the four base rates relate to each other in
  steady state? Currently the relationship is intuitive
  (T-bill ≈ reinsurance < primary insurance) but not
  derived.
- What's the protocol's optimal $\beta_E$ (entropy
  coefficient)? Higher → stronger minority-side rebate,
  more market-correcting. Lower → less distortion. The
  current value (0.3) is a guess.

### 18.2 Stress-correlation modelling

The harness's synthetic event probabilities are a poor
substitute for real stress dynamics. Open questions:

- How should insurance event probabilities be calibrated
  from real historical data, accounting for non-stationary
  underlying processes?
- What's the right way to model joint distributions of
  insurance triggers (e.g., a market crash event and a
  vol-spike event are not independent)?
- Catastrophe / weather event correlations to financial
  layers in tail scenarios — the standard assumption is
  zero, but is this true under climate-change-driven
  insurance market repricing?

### 18.3 Mechanism design

The current mechanisms (auction, classifier, B-book pool)
are hand-tuned. Open questions:

- Is the geodesic distribution the *optimal* idealised
  density for an LAP auction? Other distributions (Tukey,
  Gumbel mixture) might handle leveraged tails better.
- Is the current classifier specification (rolling 10-close
  + whale exception) optimal? An information-theoretic
  approach (treat classification as a hypothesis test on
  P&L) might give better separation.
- Should the entropy weighting use KL divergence as it does,
  or a different f-divergence (Hellinger, total variation)?

### 18.4 Composability

When FLOAT is used as collateral in another DeFi protocol,
how does damage propagate? Open questions:

- What's the right way to model cross-protocol
  thread composition? If Protocol B accepts FLOAT as
  collateral and FLOAT face damages from a Hyperfloat
  event, does Protocol B's user see the damage?
- Can multiple Trading-Tower-style protocols *share* a
  reinsurance pool, gaining diversification benefits?
- How should secondary-market trading of thread positions
  affect the protocol's solvency accounting?

### 18.5 Scale dynamics

Behaviour at small scale (hundreds of users) may differ
qualitatively from behaviour at large scale (millions).
Open questions:

- At what scale does the entropy-weighted minority-side
  rebate become large enough to be a real signal vs.
  noise?
- How does the classifier's stability scale with the
  number of B-classified users? Is there a critical
  density above which mass coordination becomes
  detectable?
- What's the appropriate liquidity-provider concentration
  limit? Real markets have rules limiting any single LP
  to (say) 5% of pool capital — does Hyperfloat need
  similar?

### 18.6 Theoretical limits

The protocol's safety claim is empirically verified but not
formally bounded. Open questions:

- What's the closed-form upper bound on
  $\Pr(\text{joint outcome} < 0)$ given parameter
  $(\rho, \sigma, \mu)$ vectors? A formal bound would let
  the protocol *prove* its safety claim mathematically,
  not just empirically.
- Can the four-layer thread mechanism be shown to be
  capital-efficiency-optimal in some axiomatic sense?
  (E.g., maximum yield given a downside-protection
  constraint.)

These are the kinds of questions that academic finance
research could meaningfully address. The protocol's open-
source codebase + harness are deliberately structured to
make external research tractable.

---

## 19. Worked Numerical Examples

This section walks through three concrete user sessions to make
the protocol's mechanics tangible. All numbers are taken from
actual harness runs, rounded to two significant figures.

### 19.1 Calm session — single user, $10,000 deposit

**Setup**:
- User U deposits $10,000.
- Easy-mode auto-mint: posts $10,000 in insurer stakes split
  evenly across 8 standard event markets ($1,250 each); buys
  reinsurance face $3k / $3k / $4k across the three reinsurance
  products (total $10,000); buys B-book reinsurance face
  $3,000; deposits $10,000 as B-book threadDerivedStake; mints
  10,000 FLOAT into wallet.
- Synthetic counterparties: insurance buyers with matched
  $10,000 face; reinsurance + B-book reinsurance sellers each
  with $100,000 capital.
- Scenario CALM: 200 medium ticks, no event triggers, no
  redemption pressure.

**Per-tick flow** (representative):

| Component | Amount | Per tick |
| :-- | --: | :-- |
| T-bill yield on cash margin | $0.00–0.50 | grows with margin |
| T-bill yield on thread principal | $1.10 | $10,000 × 0.04/365 |
| Insurance premium (insurer) | $1.50 | $10,000 × 0.0003 (balanced) |
| Reinsurance premium (buyer) | $-0.32 | $10,000 face × √(0.1) × 0.0002 |
| B-book reinsurance premium (buyer) | $-0.10 | $3,000 face × similar |

**Cumulative over 200 ticks**:

| Layer attribution | Total |
| :-- | --: |
| T-bill on margin | +$5 |
| T-bill on principal (grew thread, retained) | +$220 |
| Insurance premium net | +$298 |
| Reinsurance premium paid | -$63 |
| B-book reinsurance premium paid | -$10 |
| **Joint outcome (margin + principal − deposit)** | **+$450** |

**Result**: +4.5% over 200 sim-days = ~+8.5% annualised.
Distribution across the 200 simulated runs: tightly clustered
between +4.5% and +4.6% (CALM has near-zero variance because
nothing random happens — all flows are deterministic).

### 19.2 Crisis session — multiple insurance events trigger

**Setup**: same as 19.1, but scenario is CORRELATED_CRISIS
with seed 42. Average 1.16 events trigger per run; this
session has 1 trigger at tick 87 (BTC_CRASH_20_WEEK).

**Trigger-tick attribution** (tick 87, even tick = insurance
settlement):

| Effect | Amount |
| :-- | --: |
| Insurance market settles BTC_CRASH | $1,250 face paid out |
| User's insurer stake in this market | -$1,250 (claim_out) |
| Thread damage propagated | $1,250 across 4 layers |
| Layer 2 (other markets) withdrawn pro-rata | -$1,094 (other 7 markets × weight) |
| Layer 3 (B-book stake) shrunk | -$1,250 |
| Layer 4 (FLOAT face) | -$0 if buffer absorbs; else partial |
| Reinsurance payouts (3 products) | +$1,250 (full coverage) |

**Net effect on user wealth at tick 87**:
- Wallet: receives $1,250 from reinsurance.
- Thread principal: shrinks from $10,062 to $8,812 (lost
  $1,250).
- Net wealth change: 0 (the $1,250 transferred from thread to
  wallet via the reinsurance hedge).

**Cumulative over 200 ticks** (this seed):

| Layer attribution | Total |
| :-- | --: |
| T-bill yield (margin + principal) | +$215 |
| Insurance premium net | +$273 |
| Insurance claim received (event triggered) | $0 (user is insurer, not insured) |
| Reinsurance net (premium − payouts) | +$1,089 (net positive — covered the claim loss) |
| B-book reinsurance premium paid | -$10 |
| Thread principal damage (event) | -$1,250 (recovered via reinsurance) |
| **Joint outcome** | **+$439** |

**Result**: +4.4% — virtually identical to CALM despite the
event trigger, because reinsurance fully covered the loss. The
small $11 shortfall vs. CALM is the reinsurance premium cost.

### 19.3 Worst-case tail-event session

**Setup**: scenario BBOOK_TAIL_EVENT with seed that produces
two consecutive -5% B-book P&L spikes within the same
drawdown cycle.

**Per-tick attribution near the tail event**:
- Tick 100: B-book P&L = -0.1% × $10,000 = -$10 (Gaussian)
- Tick 102: B-book P&L = -0.1% + (-5% tail) = -$510 spike
- Tick 104: B-book P&L = -0.1% × stake = small
- Tick 106: B-book P&L = -5% tail again on top of small drift

**Cumulative B-book P&L** for this session:
- Drawdown reached: -$1,200 (peak was 0; current is -$1,200)
- B-book reinsurance attachment: $300 (= 10% of $3,000 face)
- B-book reinsurance covered layer: $300 → $1,200 = $900
  (clamped at face)

**B-book reinsurance payouts**: ~$900 across the drawdown
period (the layer above attachment, capped at face).
**B-book P&L losses on the thread**: -$1,200.

**Cumulative over 200 ticks** (this seed):

| Layer attribution | Total |
| :-- | --: |
| T-bill (margin + principal) | +$200 |
| Insurance premium net | +$298 |
| Reinsurance premium paid | -$63 |
| B-book P&L (cumulative) | -$1,200 |
| B-book reinsurance payouts | +$900 |
| B-book reinsurance premium paid | -$10 |
| **Joint outcome** | **-$95 (≈ -1%)** |

**Result**: this user takes a small net loss because the
attachment threshold ($300 = 10% of face) is uninsured. They
absorbed $300 of deductible while reinsurance covered the
$900 layer above. After protocol baseline yields, they end
~1% down on a $10k deposit.

**Across all 200 BBOOK_TAIL_EVENT runs at n=200**:
- 96% of runs: positive outcome (no large drawdown, or
  drawdown stayed below attachment).
- 4% of runs: negative outcome bounded by the deductible
  (worst observed: -4.0%).

The protocol's *promise* in this scenario: a 4% worst-case
loss vs. the unhedged 31% worst-case the harness showed
before the B-book reinsurance pool was added.

### 19.4 Comparison snapshot

For a $10,000 deposit, 200 sim-days, three scenarios:

| Scenario | Mean | p5 | p95 | Worst |
| :-- | --: | --: | --: | --: |
| CALM | +$450 | +$450 | +$450 | +$450 |
| CORRELATED_CRISIS | +$440 | +$390 | +$460 | +$390 |
| BBOOK_TAIL_EVENT | +$700 | -$200 | +$1,200 | -$400 |

Note that CRISIS has tighter variance than CALM might suggest:
all runs land between +3.9% and +4.6% because the reinsurance
hedge is doing exactly what it was designed to do. CRISIS
with no reinsurance would have variance of ±50% — the protocol
makes the worst case predictable.

BBOOK_TAIL_EVENT has higher variance because the user retains
upside on B-book gains (no symmetric hedge on the long side)
while the deductible caps downside at -$400.

---

## 20. Formal Properties and Proof Sketches

The protocol's invariants are tested at runtime; this section
sketches what their *formal* statements look like, suitable for
mechanised verification in a future audit.

### 20.1 Lockstep invariant — proof sketch

**Statement**: For any thread $T$ and any sequence of damage
events $\{(L_1, t_1), \ldots, (L_n, t_n)\}$ applied via
`damageThread`, the post-update state satisfies:

$$
P_t = P_0 - \sum_{i: t_i \leq t} \min(P_{t_i^-}, L_i)
$$

$$
\Delta\text{layer-2}_j(t) = \sum_{i: t_i \leq t} w_j \cdot \min(P_{t_i^-}, L_i)
$$

$$
\Delta\text{layer-3}(t) = \sum_{i: t_i \leq t} \min(P_{t_i^-}, L_i)
$$

$$
F_t = \min(F_0, P_t)
$$

where $P_{t^-}$ denotes the principal *just before* event at
time $t$.

**Proof sketch**: By induction on the event sequence. Base
case: $t = 0$, all sums are zero, $P_0 = F_0$ post-mint, claim
holds trivially. Inductive step: at event $i$ with applied
damage $\delta_i = \min(P_{t_i^-}, L_i)$, the function
`damageThread` returns deltas that the loop applies in this
exact form. The post-update principal is $P_{t_i^-} - \delta_i$;
post-update layer-2 stakes are $w_j \cdot \delta_i$ less per
market; post-update layer-3 is $\delta_i$ less; post-update
ttFace is $\min(F_{t_i^-}, P_{t_i^-} - \delta_i)$. The
inductive hypothesis carries forward.

**Where the proof would fail**: if any caller bypassed
`damageThread` and modified principal directly. The protocol's
discipline is that all damage paths flow through this single
function — `useEpochLoop.js` and `stressHarness.js` both call
it for every damage event. A formal proof would require this
discipline to be expressed in the type system (e.g., a privileged
`damageThread` capability that the rest of the codebase cannot
have).

### 20.2 Conservation invariant — proof sketch

**Statement**: For every medium tick $t$, the sum of wealth
changes across all participants equals the exogenous T-bill
inflow:

$$
\sum_{u \in U(t)} \Delta W_u(t) = \frac{\text{TBILL\_RATE}}{365} \cdot \sum_u P_u(t-1)
$$

**Proof sketch**: Decompose every cash flow during tick $t$
into pairs (in to one party, out from another). Specifically:

- **Auction tip**: paid by long counterparty → received by
  short counterparty (and vice versa). Sum: 0.
- **Insurance premium**: paid by buyer → received by insurers
  pro-rata. Sum: 0.
- **Insurance claim**: paid out of insurer stake (thread
  principal) → received by insured. Sum: 0 (modulo the
  thread principal reduction, which is captured in the
  user's wealth definition).
- **Reinsurance payout**: paid out of seller capital →
  received by buyer. Sum: 0.
- **Reinsurance premium**: paid by buyer → received by sellers
  pro-rata. Sum: 0.
- **B-book P&L**: moves stake from one party to another;
  voluntaryStake to wallet for outside underwriters,
  threadDerivedStake to thread principal for thread holders.
  Sum: 0 within the pool.
- **FLOAT redemption**: $X FLOAT destroyed → $(1 - \text{penalty})
  received as cash. Penalty routed to reinsurance sellers.
  Sum: 0 ($X face on the thread shrinks; $X dollars enter the
  user's wallet, less penalty, plus penalty to sellers).

The only non-zero-sum flow is T-bill yield, which by
definition comes from outside the protocol. Hence the equality.

**Test verification**: `conservation.test.js` runs this check
on every tick of every test scenario; any violation fails CI.

### 20.3 Joint-outcome safety — bound (sketch)

**Statement (informal)**: Under reasonable assumptions on the
correlation matrix between the protocol's yield sources, the
joint outcome is positive with probability $\geq 1 - \epsilon$
for some explicit $\epsilon$ depending on the parameters.

**Sketch**: Let $Y_i$ be the per-period yield from source $i$,
with mean $\mu_i$ and standard deviation $\sigma_i$. The joint
outcome over $T$ periods is

$$
J_T = T \cdot \sum_i \mu_i + \sqrt{T} \cdot Z
$$

where $Z$ is a (correlated) standard-normal variate with
variance

$$
\text{Var}(Z) = \sum_{i,j} \rho_{ij} \sigma_i \sigma_j
$$

Under the assumption that the post-reinsurance net yields have
$\sum_i \mu_i > 0$ (the protocol's economic rationality
condition) and $\sigma_{\text{stress}} < \sigma_{\text{worst-case-naive}}$
(the diversification benefit), the probability of $J_T < 0$ is
bounded by

$$
\Pr(J_T < 0) \leq \exp\left( -\frac{T (\sum \mu_i)^2}{2 \text{Var}(Z)} \right)
$$

(standard Chernoff bound on the joint distribution).

For the current calibration with $T = 200$ ticks,
$\sum \mu_i \approx 0.045 \cdot \$10{,}000 = \$450$ over the
period, and $\sqrt{\text{Var}(Z)} \approx \$200$ (estimated
from harness runs), the bound gives
$\Pr(J_T < 0) \lesssim e^{-1.27} \approx 0.28$ — much
weaker than the empirical 0% in CALM. The bound is loose
because:
- It doesn't capture the asymmetric-buffer effect that
  protects against downside specifically.
- It uses the worst-case $\sigma_{\text{stress}}$ rather than
  the calmer realised $\sigma$.
- The Chernoff bound is conservative for distributions that
  aren't heavy-tailed.

A *tight* formal bound (which would be a real research
contribution) would account for the buffer's asymmetric
absorption of damage and the reinsurance hedge's
state-dependent payoff. This is open work.

### 20.4 Acceptable parameter region

A key practical question: what's the *valid region* in
parameter space — i.e., the set of $(r_0, \rho_{ij}, \sigma_i,
\text{lockup}, \text{attachment})$ for which the safety claim
holds?

The harness can map this region empirically by sweeping
parameters, but a closed-form characterisation would let users
verify a parameter set without running 1000 simulations. This
is also open work.

For now, the harness's role is to *certify* a specific
parameter set; valid-region characterisation is for v1+ of the
protocol's mathematical foundation.

### 20.5 No-arbitrage condition

**Statement**: The protocol contains no internal arbitrage
opportunity — no sequence of mints, trades, transfers, and
redemptions yields a guaranteed risk-free profit beyond
T-bill yield.

**Sketch**: The candidate arbitrages would be:
- Mint FLOAT, immediately redeem for cash: cost > 0 (express
  penalty 5%; standard waits 31+ ticks at 10% per cycle).
  Bounded loss, no arbitrage.
- Mint FLOAT, take premium income, withdraw before trigger:
  insurance lockup (200 ticks) prevents this; thread
  redemption mechanics also prevent this.
- Buy insurance, never claim, collect coverage on a fake
  trigger: oracle network's median-of-N consensus + dispute
  window prevents fake triggers.
- Manipulate the auction's geodesic distribution to create
  artificial entropy bonuses: the meta-parameter adaptation
  (KL gradient) self-corrects within ~5 ticks.

A formal no-arbitrage proof would require mechanised
verification across these cases. The current discipline is
empirical: every sequence of operations that could plausibly
arbitrage has been tested and shown not to.

---

## 21. Audit and Verification Checklist

This section is a deliverable for protocol auditors. It maps
each invariant and safety property to its code location and
verification method.

### 21.1 Code location map

| Property | Module | Function | Verification |
| :-- | :-- | :-- | :-- |
| Lockstep damage | `lib/towerTether.js` | `damageThread` | Pure-function test in `__tests__/towerTether.test.js` |
| Lockstep growth | `lib/towerTether.js` | `growThread` | Same |
| Conservation | (cross-cutting) | n/a | `__tests__/conservation.test.js`, `__tests__/integration.test.js` |
| Epoch separation | `hooks/useEpochLoop.js` + `lib/stressHarness.js` | (stride check) | `__tests__/epochStride.test.js` |
| Tier-3 gate | `lib/ltv.js` | `evaluateTier3Gate` | `__tests__/ltv.test.js` |
| Solvency clawback | `lib/towerTether.js` | `applySolvencyCheck` | Tests + harness |
| Insurance lockup | `lib/insuranceMarket.js` | `withdrawInsurer` (currentEpoch + bypassLockup) | `__tests__/insuranceMarket.test.js` |
| Reinsurance lockup | `lib/reinsurance.js` | `postReinsuranceSeller` / `withdrawReinsuranceSeller` | `__tests__/reinsurance.test.js` |
| B-book capacity gate | `lib/bBookPool.js` | `openContract` (BBOOK_MAX_NOTIONAL_RATIO) | `__tests__/bBookPool.test.js` |
| B-book reinsurance HWM | `lib/bBookReinsurance.js` | `settleBBookReinsuranceTick` | Embedded in stress harness |
| Whale exception | `lib/userClassifier.js` | `routeFor` | `__tests__/userClassifier.test.js` |
| Auction matching optimality | `lib/auction.js` | `matchBids` | `__tests__/auction.test.js` |

### 21.2 Test coverage by category

| Category | Test files | Test count |
| :-- | :-- | --: |
| Math primitives | `math.test.js`, `correlation.test.js`, `regime.test.js` | 28 |
| Auction | `auction.test.js` | 12 |
| Insurance | `insuranceMarket.test.js`, `insuranceEvents.test.js` | 35 |
| Reinsurance | `reinsurance.test.js` | varies |
| B-book pool | `bBookPool.test.js`, `userClassifier.test.js` | varies |
| LTV / tier gates | `ltv.test.js`, `credit.test.js` | 32 |
| Capital tags / role ledger | `capitalTags.test.js`, `roleLedger.test.js` | 23 |
| Settlement | `settlement.test.js`, `pool.test.js` | 20 |
| Conservation / integration | `conservation.test.js`, `integration.test.js` | 6 |
| Epoch separation | `epochStride.test.js` | 4 |
| Stress harness | `stressHarness.test.js` | 8 |
| Order flow | `orderFlow.test.js` | 11 |
| **Total** | **29 files** | **364 tests** |

### 21.3 External dependencies (production)

When the protocol is productionised, the following external
components become trust dependencies:

| Component | Vendor | Trust assumption |
| :-- | :-- | :-- |
| Price oracles | Chainlink + Pyth | Median-of-N is unmanipulated |
| Event oracles | UMA + custom | Optimistic dispute resolution works |
| Custody | Anchorage / Fireblocks | Standard institutional custody |
| KYC | Sumsub / Persona | Identity verification accuracy |
| Sanctions | Chainalysis / TRM | Address screening accuracy |
| Smart-contract audits | Trail of Bits + Spearbit | Auditors find critical bugs |

### 21.4 Operational checklist

Pre-launch:
- [ ] Two independent smart-contract audits passed.
- [ ] Formal verification of lockstep invariant (Halmos / Certora).
- [ ] Stress harness runs on every commit; CI gate on
      P(joint ≥ 0) ≥ 0.95.
- [ ] Real historical replay validated against COVID-March,
      August 2024 yen-carry, one credit stress event.
- [ ] Bug bounty live (Immunefi, $1M+ for critical).
- [ ] Multi-sig + timelock on all upgrade keys.
- [ ] Oracle network has ≥ 3 independent sources per feed.
- [ ] Compliance / KYC integration tested per jurisdiction.
- [ ] Insurance / e-money licence in target jurisdiction.

Continuous:
- [ ] Per-tick conservation invariant alarmed.
- [ ] Per-tick lockstep invariant alarmed.
- [ ] Pool capacity utilisation < 90% (auto-pause threshold).
- [ ] Classifier divergence < 2σ (auto-pause threshold).
- [ ] Oracle staleness < 10 ticks (auto-pause threshold).
- [ ] Reinsurance pool depth > 5× expected aggregate loss.
- [ ] Daily harness re-run with current parameters.
- [ ] Weekly audit log review.
- [ ] Monthly stress test with new historical events.

Incident response:
- [ ] Documented runbook for each failure mode in §13.
- [ ] On-call rotation with sub-15-minute response SLA.
- [ ] Pre-authorised emergency multi-sig veto for governance attacks.
- [ ] Post-incident public disclosure within 24 hours.

### 21.5 Auditor questions to anticipate

A serious auditor will ask:

1. *What's the worst-case loss for a FLOAT holder under any
   sequence of valid protocol operations?* — Bounded by the
   reinsurance deductibles plus express-redemption penalty.
   Closed-form bound is open work (§20.3).
2. *Can a coordinated attacker force a thread to under-collateralise
   without their own losses?* — No: every attack vector requires
   the attacker to absorb their own losses (Sybil, classifier
   gaming, oracle manipulation all cost the attacker more than
   they extract).
3. *What's the protocol's behaviour under a 1-in-100-year
   correlated event?* — The harness's BBOOK_TAIL_EVENT
   simulates this; the answer is 96% positive with bounded
   downside.
4. *What happens when a parameter change has unintended
   consequences?* — Harness validation gate prevents adoption
   of changes that fail the empirical safety test. Plus
   timelock gives time to react.
5. *What's the protocol's behaviour at scale?* — Open work.
   Current harness is single-user; multi-user dynamics need
   capacity-audit (§9.6) at production scale.

---

## 22. A Deeper Comparison with Ethena (USDe)

Ethena's USDe is the most relevant competitor — it shares the
"novel-collateral stablecoin with meaningful yield" thesis and
has shipped at scale ($5B+ TVL). This section walks through
the comparison in more detail than §15.1 allowed.

### 22.1 What's similar

- Both target *high yield with stable face value* in a
  retail-friendly form.
- Both rely on a *non-traditional collateral mechanism* rather
  than overcollateralisation.
- Both deliver yield via *income from a market mechanism*
  (Ethena: perp funding; Hyperfloat: insurance premiums +
  B-book P&L).
- Both have a *holder-separate-from-yield* design (sUSDe is
  the yield-bearing version of USDe; Hyperfloat's FLOAT is
  fixed face, with yield going to the minter via the thread).

### 22.2 What's structurally different

**Yield source diversification**: USDe's yield is concentrated
in one mechanism — the basis trade between spot ETH and the
ETH perp futures. When perp funding goes negative (bear
markets, mid-2022 to mid-2023 conditions), USDe's yield drops
sharply or goes negative. Hyperfloat's yield is from four
uncorrelated sources, so a regime shift in any one (e.g.,
insurance triggers spike) has bounded impact on the others.

**Single-counterparty concentration**: USDe relies on
centralised perp exchanges (Binance, Bybit, OKX) holding the
collateral. Hyperfloat has no equivalent single-counterparty
dependency — the insurance markets and B-book pools are
internal to the protocol; reinsurance is multi-product with
independent capital.

**Downside protection**: USDe's downside in stress is
largely uncovered — the basis trade can produce realised
losses if perp funding inverts persistently. Hyperfloat has
explicit reinsurance covering both layer-2 and layer-3 risks,
empirically verified to cap downside at the deductible.

**Transparency model**: USDe's yield mechanism is well-
documented but the *specific* counterparty exposure (which
perp exchanges hold what positions) is opaque in real time.
Hyperfloat's per-user position attribution is fully
transparent (every flow is a named counterparty pair, see §6.1).

### 22.3 What Ethena does better (today)

- **Distribution**: 5B+ TVL is real adoption that Trading
  Tower will need years to match.
- **Operational maturity**: Ethena has launched, run through
  multiple market regimes, and survived. Hyperfloat is
  still pre-production.
- **Liquidity**: USDe has deep secondary-market liquidity on
  multiple chains. FLOAT secondary liquidity will need to be
  bootstrapped.
- **Simplicity**: Ethena's single-mechanism story is easier
  to pitch to retail. Hyperfloat's four-layer story
  requires more explanation, even with Easy mode.

### 22.4 What Hyperfloat does better (in design)

- **Stress robustness**: the harness empirically verifies the
  joint-outcome claim across stress scenarios that USDe has
  no equivalent verification mechanism for.
- **Risk distribution**: layer diversification means no
  single regime shift can break the protocol; USDe's basis
  trade is one trade.
- **Hedge architecture**: explicit reinsurance for layers 2
  and 3 is structurally absent from USDe.
- **Transparent classifier**: the A/B distinction with whale
  exception has no parallel in USDe (which doesn't have an
  active-trader counterparty layer at all).
- **Capital efficiency**: same dollar earns from four sources;
  Ethena's dollar earns from one (basis).

### 22.5 Possible hybrid

The two protocols are not mutually exclusive. A future
extension could allow the user's principal to be *partially
deployed* via the Ethena basis trade as one of the four
layers. The mechanic would be:
- Layer 1 (current): T-bill, 60% of principal.
- Layer 1' (new): Basis trade via Ethena-style hedge, 40% of
  principal. Yield: perp funding income; risk: funding
  inversion bounded by the standard hedge structure.

Adding this requires composability with Ethena's
infrastructure (or a clone of it) and careful risk
modelling. It's a v3+ topic, not a v1 priority, but it's
plausible and would provide diversification benefits for
both protocols.

---

## 23. Limitations

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

## 24. Conclusion

Hyperfloat demonstrates that capital efficiency and bounded
downside are not necessarily in tension. The four-layer thread
mechanism puts one dollar in four uncorrelated yield-producing
roles simultaneously, with damage propagation in lockstep and
growth accumulating as a buffer that absorbs subsequent damage
before FLOAT face is at risk. The reinsurance architecture covers the
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
| $F$ | Thread FLOAT face (layer 4) |
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

## Appendix D — Glossary

| Term | Definition |
| :-- | :-- |
| **Thread** | The protocol's atomic unit. A single $1 of free margin committed via mint, simultaneously playing four (or more) yield-producing roles with lockstep solvency accounting. |
| **Layer** | One of the roles a thread's principal plays. Layer 1 (T-bill), 2 (insurance seller), 3 (B-book pool stake), 4 (FLOAT face). Future extensions add layers 5+. |
| **Lockstep** | The invariant that damage to any layer propagates proportionally across all layers in the same tick; growth fattens layers 1–3 while leaving layer 4 (FLOAT face) unchanged. |
| **Buffer** | $P - F$, the gap between a thread's principal and outstanding FLOAT face. Built up by growth events; absorbs damage before FLOAT face shrinks. |
| **FLOAT** | Float, the protocol's stablecoin. 1 FLOAT = 1 USD claim, redeemable via the queue. Minted 1:1 against thread principal. |
| **Mint** | Atomic operation that opens a new thread: tags margin, posts insurer stakes, buys reinsurance + B-book reinsurance, deposits B-book stake, mints FLOAT. |
| **Standard redemption** | Slow exit: 10% of FLOAT supply per cycle (~monthly), no penalty. |
| **Express redemption** | Fast exit: 5% penalty, bypasses the cap, rerouted to reinsurance sellers. |
| **Solvency clawback** | When $\sum F > \sum P$ for a user's threads, extra FLOAT is clawed back from wallet to wipe phantom face. Residual becomes soft debt. |
| **Joint outcome** | $\text{wealth}_T - \text{deposit}_0$. The end-of-period wealth change for a user, summed across wallet + thread principal. |
| **Epoch-separation invariant** | Insurance damage and LAP/B-book damage never coincide on the same tick (coprime strides). |
| **Conservation invariant** | Per-tick net cash flow across all participants equals only the exogenous T-bill yield inflow. All internal flows zero-sum. |
| **Tier-3 gate** | Hard requirement to open active LAP exposure: ≥3 markets allocated, max 50% in any single, reinsurance bought. |
| **Geodesic distribution** | The auction's idealised leverage density — bimodal log-normal mixture in log-leverage space, with Cornish-Fisher 2nd-order correction. |
| **Entropy weight** | Per-bucket KL-divergence-based multiplier that boosts under-supplied-bucket tip rates. The mechanism behind "paid for the unpopular side". |
| **A/B classifier** | Per-user skill-based routing: A-classified users peer-match in the auction, B-classified route to the B-book pool. Whale exception forces A regardless of score. |
| **Whale exception** | A single position $> 2 \times$ rolling-average-margin force-classes to A. Prevents lose-small / bet-big gaming. |
| **Reinsurance** | Three-product layer-2 hedge: covers insurance-seller losses with summed coverage fraction = 1. Auto-bought at mint; lockup 200 ticks. |
| **B-book reinsurance** | Single-product layer-3 hedge: high-water-mark stop-loss on user's cumulative B-book P&L; attachment 10% of face, exhaustion 100% of face. |
| **Stress harness** | The Monte Carlo simulator (`lib/stressHarness.js`) that runs seeded scenarios and reports the joint-outcome distribution. The empirical safety-claim verifier. |
| **Acceptance gate** | The harness's role in protocol governance: any parameter change or new layer must demonstrably *not worsen* P(joint outcome ≥ 0) before adoption. |

---

*This is a working draft. Comments and corrections welcome.*
