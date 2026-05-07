// System-wide constants. Grouped for easy tuning and documentation.

// Risk-free rate (ANNUALISED). Applied per medium tick as
// TBILL_RATE / 365 (the loop and pool both treat it as a per-year
// rate). Calibrated to a realistic short-duration T-bill yield —
// previously 0.001 (≈0.1% annual) which made layer 1 effectively
// inert; bumped to 0.04 in Sprint 4.5 after the stress harness
// flagged the calibration error.
export const TBILL_RATE = 0.04;

// Epoch-separation invariant (Tier 1.0).
//
// Insurance settlement (markets, reinsurance, insurance-driven
// thread damage) runs every INSURANCE_STRIDE medium ticks. LAP /
// B-book settlement (when active-flow path is wired in Tier 1.1)
// runs on the OFF-stride. They never coincide, so a single thread
// principal cannot be debited by two damage paths in the same tick.
//
// Set to 2 (even ticks). Insurance rates (BASE_PREMIUM_RATE and
// REINSURANCE_BASE_RATE) are doubled in this sprint to compensate
// for the halved settlement frequency, keeping annualised yield
// constant.
export const INSURANCE_STRIDE = 2;

// Grace window after a user edit before the new config is picked up by the auction.
export const GRACE_MS = 800;

// Three-tier epoch architecture
// - Fast   (~1s):  safety monitoring (deterministic barrier checks)
// - Medium (~6s):  auction + per-tick settlement
// - Slow   (every SLOW_EVERY medium ticks): regime detection,
//                  cross-market correlation, adaptive auction meta-params
//
// Float redemption runs on its own much longer prime stride
// (~monthly in sim-days) so the queue creates real liquidity pressure
// and FLOAT functions like a bank's redemption window. 31 is coprime with
// SLOW_EVERY so analytics + redemption never settle in the same frame.
export const FAST_MS = 1000;
export const MEDIUM_MS = 6000;
export const SLOW_EVERY = 5;
export const REDEMPTION_EVERY = 31;

// History pruning: keep last N snapshots per pair to bound memory growth.
export const MAX_HISTORY = 200;

// Safety scalar used by ESMA dynamic-cap volatility scaling.
export const INSURANCE_K = 3.0;
export const EPOCH_DT_DAYS = 1 / 365;

// Entropy weighting (auction yield distribution)
export const ENTROPY_BETA = 0.3;
export const ENTROPY_EPS = 0.05;

// Adaptive meta-parameters for the geodesic leverage distribution
// (KL-gradient descent learning rate).
export const ADAPTIVE_LR = 0.005;

// Soft-close boundary: last 20% of each medium epoch is frozen for deterministic clear
export const SOFT_CLOSE_PCT = 0.8;

// -----------------------------------------------------------------------
// Float (FLOAT) — thread-based hyper-rehypothecated stablecoin
// -----------------------------------------------------------------------
//
// Mint is 1:1 against free margin (no LTV gate, no coefficient). The
// minted dollar simultaneously backs four full-notional positions:
// T-bill stake, insurance-seller stakes across reinsurance-covered
// markets, a delta-neutral paired LAP, and the FLOAT itself.

// Standard redemption capacity per cycle as a fraction of total FLOAT
// supply at cycle start. Anything beyond this either waits in queue
// or pays the express penalty.
export const STANDARD_REDEMPTION_CAP_PCT = 0.10;

// Express tier penalty rate — fraction of redeemed amount the holder
// forfeits to skip the queue / clear above the cap. Routed to
// reinsurance sellers via the epoch loop.
export const EXPRESS_PENALTY_RATE = 0.05;

// -----------------------------------------------------------------------
// B-book pool — opt-in counterparty for B-classified user flow
// -----------------------------------------------------------------------

// Maximum total active notional the pool can underwrite, expressed as
// a multiple of the pool's underwriter stake. 1.5× means underwriters
// can be on the hook for up to 150% of their staked capital in user
// notional outstanding at any time. New contracts are refused once
// this is breached — protects underwriters from blow-up.
export const BBOOK_MAX_NOTIONAL_RATIO = 1.5;

// Lockup period (in medium ticks) before an underwriter can withdraw
// their deposit. Stops them from fleeing mid-loss. Mirrors the
// reinsurance lockup design.
export const BBOOK_LOCKUP_EPOCHS = 100;

// -----------------------------------------------------------------------
// Tier-3 stake split between LAP pool (passive LP) and B-book pool
// (passive bookie). Path A default: 80 / 20.
//
// LAP pool is the safer, lower-yield passive role — it absorbs
// auction imbalance and earns entropy-rebate tips. B-book pool is the
// higher-yield-but-tail-exposed role — it takes the OPPOSITE side of
// retail flow and earns the difference.
//
// Default biases retail toward the safer pool. Power users can tilt
// the ratio with the slider in the FloatsDesk.
// -----------------------------------------------------------------------
export const MINT_LAP_POOL_SHARE_DEFAULT = 0.8;

// LAP pool — passive market-maker for auction imbalance.
// -----------------------------------------------------------------------

// Maximum medium ticks an absorbed contract sits on the pool before the
// per-tick maintenance pass closes it at the current price. Bounds
// directional exposure: even if opposite-side flow never returns, the
// pool unwinds within a known window. 20 medium ticks ≈ a couple of
// minutes at default speed; tunable.
export const LAP_POOL_HOLD_EPOCHS = 20;

// Fraction of stability-fee revenue the pool is allowed to draw on per
// tick to fund rebate income. The rest stays with the protocol fee
// ledger. Capping at < 1 keeps a residual fee stream for the protocol
// even when the pool is fully utilised.
export const LAP_POOL_REBATE_FEE_SHARE = 0.7;
