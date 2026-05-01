// User classifier — A-book vs B-book routing.
//
// Every closed position contributes to the user's rolling skill score.
// A-classified users route through the normal cross-match auction.
// B-classified users' unmatched bids route to the B-book pool, where
// underwriters take the opposite side.
//
// Why not just route everyone through the auction? When the book is
// imbalanced (e.g. 5 longs, 1 short), 4 longs sit unmatched and the
// auction soft-closes — bad for user experience and liquidity. The
// B-book absorbs the unmatched flow against opt-in underwriters who
// price the directional risk.
//
// Why classify at all? Two reasons:
//
//   1. Underwriters need to know what kind of flow they're absorbing.
//      Indiscriminate B-booking against a skilled trader drains the pool.
//      Classification lets underwriters absorb statistically-losing flow
//      (the realistic majority of retail) while skilled traders peer-match.
//
//   2. Skilled (A) traders DON'T need B-book filling — their bids should
//      cross peer-to-peer, and they benefit from waiting for a real
//      counterparty rather than getting unfavorable B-book pricing.
//
// CRITICAL DESIGN PROPERTY: classification is FULLY TRANSPARENT.
// Every user sees their score, the components, and what would flip
// them to A. No hidden routing — that's the moral failing of CFD
// brokers that this protocol explicitly fixes.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Number of most-recent closes used for classification. Smaller window
// means faster reclassification but noisier signal.
export const CLASSIFIER_WINDOW = 10;

// Minimum closes required before a user can be classified A. Until
// they have this many closes, they're B by default — most retail loses
// money, so this is the realistic prior.
export const CLASSIFIER_MIN_CLOSES = 3;

// Score threshold for A. Above this → A; at or below → B.
export const CLASSIFIER_A_THRESHOLD = 0.05;

// Score weights — sum to ~1 for interpretability.
export const SCORE_W_AVG_RETURN = 0.5;
export const SCORE_W_WIN_RATE = 0.3;
export const SCORE_W_SHARPE = 0.2;

// Whale exception: if a single position's margin > this multiple of
// the user's rolling-average margin, that position is force-classed
// to A regardless of score. Prevents "lose small to stay B, then bet
// big" gaming.
export const WHALE_MARGIN_MULT = 2.0;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initClassifierState() {
  return { byUser: {} };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getUserClass(state, userId) {
  return state?.byUser?.[userId]?.currentClass ?? "B";
}

export function getUserScore(state, userId) {
  return state?.byUser?.[userId]?.score ?? 0;
}

export function getUserStats(state, userId) {
  const u = state?.byUser?.[userId];
  if (!u) {
    return {
      currentClass: "B",
      score: 0,
      breakdown: {
        avgReturn: 0,
        winRate: 0,
        sharpe: 0,
      },
      closes: 0,
      avgMargin: 0,
      reasonText: `Need ${CLASSIFIER_MIN_CLOSES} closed positions to compute a score (default B).`,
    };
  }
  return {
    currentClass: u.currentClass,
    score: u.score,
    breakdown: { ...u.breakdown },
    closes: u.closedPositions.length,
    avgMargin: u.avgMargin,
    reasonText: u.reasonText,
  };
}

// ---------------------------------------------------------------------------
// Score math
// ---------------------------------------------------------------------------

// Compute score from a recent closed-position window. Each close
// contributes a percentage return: pnl / marginAtOpen.
export function scoreFromCloses(closes) {
  if (!closes || closes.length === 0) {
    return {
      score: 0,
      breakdown: { avgReturn: 0, winRate: 0, sharpe: 0 },
    };
  }
  const returns = closes.map((c) => {
    const m = Math.max(1e-9, c.marginAtOpen ?? 1);
    return (c.pnl ?? 0) / m;
  });
  const avgReturn = returns.reduce((s, v) => s + v, 0) / returns.length;
  const wins = returns.filter((r) => r > 0).length;
  const winRate = wins / returns.length;
  const variance =
    returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / returns.length;
  const std = Math.sqrt(variance);
  const sharpe = std > 1e-9 ? avgReturn / std : avgReturn > 0 ? 1 : -1;

  // Component-weighted sum. Each component is roughly in [-1, 1] so
  // the final score is also bounded ~[-1, 1].
  const score =
    SCORE_W_AVG_RETURN * Math.max(-1, Math.min(1, avgReturn * 5)) +
    SCORE_W_WIN_RATE * (winRate - 0.5) * 2 +
    SCORE_W_SHARPE * Math.max(-1, Math.min(1, sharpe));

  return {
    score,
    breakdown: { avgReturn, winRate, sharpe },
  };
}

function buildReasonText(closes, score, currentClass) {
  if (closes.length < CLASSIFIER_MIN_CLOSES) {
    const need = CLASSIFIER_MIN_CLOSES - closes.length;
    return `Default B until ${need} more closed position${need > 1 ? "s" : ""}.`;
  }
  if (currentClass === "A") {
    return `A-classified — peer-matched flow (score ${score.toFixed(2)} > ${CLASSIFIER_A_THRESHOLD}).`;
  }
  const gap = CLASSIFIER_A_THRESHOLD - score;
  return `B-classified — score ${score.toFixed(2)}, need +${gap.toFixed(2)} to reach A.`;
}

// ---------------------------------------------------------------------------
// Record + classify
// ---------------------------------------------------------------------------

// Append a closed position to the user's rolling window and
// recompute their class. Returns new classifier state.
//
// `close` shape: { pnl, marginAtOpen, closedAtEpoch }
export function recordClose(state, userId, close) {
  const prev = state?.byUser?.[userId] ?? {
    closedPositions: [],
    currentClass: "B",
    score: 0,
    breakdown: { avgReturn: 0, winRate: 0, sharpe: 0 },
    avgMargin: 0,
    reasonText: "",
  };

  const next = [
    ...prev.closedPositions,
    {
      pnl: close.pnl ?? 0,
      marginAtOpen: close.marginAtOpen ?? 0,
      closedAtEpoch: close.closedAtEpoch ?? 0,
    },
  ].slice(-CLASSIFIER_WINDOW);

  const { score, breakdown } = scoreFromCloses(next);
  const avgMargin =
    next.reduce((s, c) => s + (c.marginAtOpen ?? 0), 0) /
    Math.max(1, next.length);

  let currentClass = "B";
  if (
    next.length >= CLASSIFIER_MIN_CLOSES &&
    score > CLASSIFIER_A_THRESHOLD
  ) {
    currentClass = "A";
  }

  const reasonText = buildReasonText(next, score, currentClass);

  return {
    ...state,
    byUser: {
      ...state.byUser,
      [userId]: {
        closedPositions: next,
        currentClass,
        score,
        breakdown,
        avgMargin,
        reasonText,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

// Decide where an opening position should route. A user with high
// score AND a position margin within their normal size routes peer.
// Whales (margin >> rolling avg) get force-classed to A so they
// can't silently drain the B-book pool with a single big bet.
//
// Returns 'A' | 'B' for routing.
export function routeFor({ state, userId, positionMargin }) {
  const u = state?.byUser?.[userId];
  if (!u || u.closedPositions.length < CLASSIFIER_MIN_CLOSES) {
    return "B"; // default
  }
  // Whale exception.
  if (
    u.avgMargin > 0 &&
    positionMargin > u.avgMargin * WHALE_MARGIN_MULT
  ) {
    return "A";
  }
  return u.currentClass;
}
