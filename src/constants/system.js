// System-wide constants. Grouped for easy tuning and documentation.

// Risk-free rate applied per epoch (~1 day).
export const TBILL_RATE = 0.001;

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

// Auction sub-unit cascade — fractional leverage steps used when the
// best long/short bid sizes differ.
export const SUB_UNIT_STEPS = [0.75, 0.5, 0.25];

// Entropy weighting (auction yield distribution)
export const ENTROPY_BETA = 0.3;
export const ENTROPY_EPS = 0.05;

// Adaptive meta-parameters for the geodesic leverage distribution
// (KL-gradient descent learning rate).
export const ADAPTIVE_LR = 0.005;

// Soft-close boundary: last 20% of each medium epoch is frozen for deterministic clear
export const SOFT_CLOSE_PCT = 0.8;

// -----------------------------------------------------------------------
// Tower Tether (TT) — fully-collateralized stablecoin
// -----------------------------------------------------------------------

// Mint cap = totalAllocatedStake × LTV × MINT_COEFFICIENT. Conservative
// default; half of LTV-adjusted allocation available as TT.
export const MINT_COEFFICIENT = 0.5;

// Minimum LTV required to mint at all. Forces diversification before a
// depositor can extract circulating-stablecoin claims.
export const MINT_LTV_GATE = 0.6;

// Standard redemption capacity per cycle as a fraction of total TT
// supply at cycle start. Anything beyond this either waits in queue
// or pays the express penalty.
export const STANDARD_REDEMPTION_CAP_PCT = 0.10;

// Express tier penalty rate — fraction of redeemed amount the holder
// forfeits to skip the queue / clear above the cap.
export const EXPRESS_PENALTY_RATE = 0.05;
