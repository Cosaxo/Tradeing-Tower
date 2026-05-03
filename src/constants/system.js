// System-wide constants. Grouped for easy tuning and documentation.

// Risk-free rate (ANNUALISED). Applied per medium tick as
// TBILL_RATE / 365 (the loop and pool both treat it as a per-year
// rate). Calibrated to a realistic short-duration T-bill yield —
// previously 0.001 (≈0.1% annual) which made layer 1 effectively
// inert; bumped to 0.04 in Sprint 4.5 after the stress harness
// flagged the calibration error.
export const TBILL_RATE = 0.04;

// Grace window after a user edit before the new config is picked up by the auction.
export const GRACE_MS = 800;

// Three-tier epoch architecture
// - Fast   (~1s):  safety monitoring (deterministic barrier checks)
// - Medium (~6s):  auction + per-tick settlement
// - Slow   (every SLOW_EVERY medium ticks): regime detection,
//                  cross-market correlation, adaptive auction meta-params
//
// Tower Tether redemption runs on its own much longer prime stride
// (~monthly in sim-days) so the queue creates real liquidity pressure
// and TT functions like a bank's redemption window. 31 is coprime with
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
// Tower Tether (TT) — thread-based hyper-rehypothecated stablecoin
// -----------------------------------------------------------------------
//
// Mint is 1:1 against free margin (no LTV gate, no coefficient). The
// minted dollar simultaneously backs four full-notional positions:
// T-bill stake, insurance-seller stakes across reinsurance-covered
// markets, a delta-neutral paired LAP, and the TT itself.

// Standard redemption capacity per cycle as a fraction of total TT
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
