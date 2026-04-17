// System-wide constants. Grouped for easy tuning and documentation.

// Risk-free rate applied per epoch (~1 day).
export const TBILL_RATE = 0.001;

// Grace window after a user edit before the new config is picked up by the auction.
export const GRACE_MS = 800;

// Three-tier epoch architecture
// - Fast   (~1s):  safety monitoring (deterministic barrier checks)
// - Medium (~6s):  auction + contract settlement
// - Slow   (~30s): analytics, pool settlement, parameter adaptation (every 5th medium)
export const FAST_MS = 1000;
export const MEDIUM_MS = 6000;
export const SLOW_EVERY = 5;

// History pruning: keep last N snapshots per pair to bound memory growth.
export const MAX_HISTORY = 200;

// Gaussian width seed for legacy auction fallback.
export const ALPHA = 2.0;

// Insurance module
export const INSURANCE_PREMIUM_RATE = 0.0002;
export const INSURANCE_K = 3.0;
export const EPOCH_DT_DAYS = 1 / 365;
export const SUB_UNIT_STEPS = [0.75, 0.5, 0.25];

// Pool
export const POOL_STABILITY_FEE = 0.02; // 2% of tip revenue routed to pool each medium epoch
export const POOL_MAX_CLAIM_RATIO = 0.5;
export const POOL_LOCKUP_EPOCHS = 50;
export const POOL_DEPTH_MAX = 2.0;

// Imbalance contracts
export const IMB_MAX_DURATION = 30;
export const IMB_PAYOUT_BASE = 1000;

// Entropy contracts
export const ENT_LAMBDA = 0.15;

// Loss strip
export const STRIP_INSURER_BOOST = 0.12;
export const MAX_STRIP_PROTECTED = 0.8;
export const MAX_INSURER_BOOK_MULT = 3.0;

// Yield buffer contribution rates
export const YIELD_BUFFER_THRESHOLD = 0.05;
export const YIELD_BUFFER_MIN_RATE = 0.02;
export const YIELD_BUFFER_MAX_RATE = 0.15;

// Loyalty programme for time-weighted yield
export const LOYALTY_ALPHA = 0.4;
export const LOYALTY_CAP = 20;

// Entropy weighting
export const ENTROPY_BETA = 0.3;
export const ENTROPY_EPS = 0.05;
export const SMILE_EMA_ALPHA = 0.3;

// Adaptive meta-parameters for geodesic distribution
export const ADAPTIVE_LR = 0.005;
export const ADAPTIVE_MU_SCALE_INIT = 0.7;
export const ADAPTIVE_SIGMA_SCALE_INIT = 0.12;

// Credit facility
export const CREDIT_BASE_RISK_BUDGET = 50;

// Soft-close boundary: last 20% of each medium epoch is frozen for deterministic clear
export const SOFT_CLOSE_PCT = 0.8;
