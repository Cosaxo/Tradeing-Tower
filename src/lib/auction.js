// Auction clearinghouse: geodesic leverage distribution + entropy yield weighting.
//
// The "geodesic" distribution lives in log-leverage space. A bimodal log-normal
// mixture captures both conservative (low-lev) and speculative (high-lev) rational
// preferences. Meta-parameters adapt each epoch via KL-gradient descent so the
// distribution self-calibrates to the actual order flow.

import { ENTROPY_BETA, ENTROPY_EPS, ADAPTIVE_LR, SOFT_CLOSE_PCT, SUB_UNIT_STEPS } from "../constants/system.js";
import { timeWeightedYieldMult } from "./math.js";

export { timeWeightedYieldMult };

// ---------------------------------------------------------------------------
// Geodesic weight
// ---------------------------------------------------------------------------

// Returns the unnormalised probability density at `lev` for one side of the book.
// Two log-normal modes in log-leverage space, blended by `ratio` (0=balanced, >0 skewed long/short).
// Cornish-Fisher 2nd-order correction applied when skewness (sk) or excess kurtosis (ek) is non-zero.
export function geodesicWeight(lev, ratio, realizedSigma, sk = 0, ek = 0, metaParams = {}) {
  if (lev <= 0) return 0;

  const logLev = Math.log(Math.max(0.001, lev));
  const sigmaBase = Math.max(0.3, Math.min(2.5, realizedSigma * 15));

  const { muLow = 0, muHigh = null, sigmaMix = null, alpha = 0.5 } = metaParams;

  const lowMode = muLow;
  const highMode = muHigh ?? Math.log(Math.max(2, lev)) * 0.6;
  const sigma = sigmaMix ?? sigmaBase;

  const blend = Math.min(1, Math.max(0, 0.5 + ratio * 0.4));

  const dLow = logLev - lowMode;
  const dHigh = logLev - highMode;

  // Cornish-Fisher z-scores: z_cf = z + (z^2 - 1)*sk/6 + (z^3 - 3z)*ek/24
  function cfDensity(d, sig) {
    const z = d / Math.max(0.001, sig);
    const zCf = z + ((z * z - 1) * sk) / 6 + ((z * z * z - 3 * z) * ek) / 24;
    return Math.exp((-0.5 * zCf * zCf) / (sig * sig)) / Math.max(0.001, sig);
  }

  const wLow = (1 - blend) * cfDensity(dLow, sigma);
  const wHigh = blend * cfDensity(dHigh, sigma) * alpha;

  return Math.max(0, wLow + wHigh);
}

// ---------------------------------------------------------------------------
// Smile parameters (skewness / excess kurtosis from live bids)
// ---------------------------------------------------------------------------

export function estimateSmileParams(bids, ratio) {
  if (!bids || bids.length < 3) return { sk: 0, ek: 0 };

  const levs = bids.map((b) => Math.log(Math.max(0.001, b.leverage)));
  const n = levs.length;
  const mean = levs.reduce((s, v) => s + v, 0) / n;
  const m2 = levs.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
  const m3 = levs.reduce((s, v) => s + (v - mean) ** 3, 0) / n;
  const m4 = levs.reduce((s, v) => s + (v - mean) ** 4, 0) / n;

  const std = Math.sqrt(Math.max(1e-8, m2));
  const sk = std > 0 ? m3 / std ** 3 : 0;
  const ek = std > 0 ? m4 / std ** 4 - 3 : 0;

  // Directional bias nudges skew toward observed ratio tilt.
  const ratioBias = Math.sign(ratio) * 0.15;

  return {
    sk: Math.max(-2, Math.min(2, sk + ratioBias)),
    ek: Math.max(-1, Math.min(3, ek)),
  };
}

export function blendSmileParams(prior, live) {
  const alpha = 0.3;
  return {
    sk: prior.sk * (1 - alpha) + live.sk * alpha,
    ek: prior.ek * (1 - alpha) + live.ek * alpha,
  };
}

// ---------------------------------------------------------------------------
// Entropy weights — minority bucket premium
// ---------------------------------------------------------------------------

// For each leverage bucket, compute how under-supplied it is vs ideal, then
// normalise to a weight so thin buckets earn more yield.
export function calcEntropyWeights(idealBuckets, actualBuckets, prevSmoothFills) {
  const n = idealBuckets.length;
  const smooth = prevSmoothFills && prevSmoothFills.length === n ? prevSmoothFills : null;

  const fills = idealBuckets.map((ideal, i) => {
    const actual = actualBuckets[i] ?? 0;
    const prev = smooth ? smooth[i] : actual;
    const smoothed = prev * 0.7 + actual * 0.3;
    return { ideal: Math.max(ENTROPY_EPS, ideal), actual: smoothed };
  });

  // KL per bucket: p * log(p/q)
  const totalIdeal = fills.reduce((s, f) => s + f.ideal, 0);
  const totalActual = fills.reduce((s, f) => s + f.actual, 0) || 1;

  const kls = fills.map((f) => {
    const p = f.ideal / totalIdeal;
    const q = Math.max(ENTROPY_EPS, f.actual) / totalActual;
    return p > 0 ? p * Math.log(p / q) : 0;
  });

  // Weight = 1 + beta * normalised KL (under-supplied → higher weight).
  const maxKl = Math.max(1e-8, ...kls);
  const weights = kls.map((kl) => 1 + ENTROPY_BETA * (kl / maxKl));
  const totalW = weights.reduce((s, w) => s + w, 0) || 1;
  const normWeights = weights.map((w) => w / totalW);

  const newSmooth = fills.map((f) => f.actual);
  return { normWeights, smoothFills: newSmooth };
}

// Map a user's leverage to the nearest bucket and return that bucket's entropy multiplier.
export function getEntropyMultForUser(userLeverage, normWeights, bucketLevsArr) {
  if (!normWeights || !bucketLevsArr || bucketLevsArr.length === 0) return 1;
  let closest = 0;
  let minDist = Infinity;
  bucketLevsArr.forEach((bl, i) => {
    const d = Math.abs(bl - userLeverage);
    if (d < minDist) {
      minDist = d;
      closest = i;
    }
  });
  // Scale so average weight ≈ 1.
  const avg = normWeights.reduce((s, w) => s + w, 0) / normWeights.length;
  return avg > 0 ? normWeights[closest] / avg : 1;
}

// ---------------------------------------------------------------------------
// Adaptive meta-parameters (KL gradient descent)
// ---------------------------------------------------------------------------

// Accepts an optional `learningRate` override (set by Floor 5 governance).
export function adaptMetaParams(
  prevParams,
  actualBuckets,
  idealBuckets,
  ratio,
  realizedSigma,
  learningRate = ADAPTIVE_LR
) {
  const n = idealBuckets.length;
  if (n === 0) return prevParams;

  const totalIdeal = idealBuckets.reduce((s, v) => s + v, 0) || 1;
  const totalActual = actualBuckets.reduce((s, v) => s + v, 0) || 1;

  // KL gradient: direction to shift muLow / muHigh to better match ideal.
  let gradMuLow = 0;
  let gradAlpha = 0;

  for (let i = 0; i < n; i++) {
    const p = idealBuckets[i] / totalIdeal;
    const q = Math.max(ENTROPY_EPS, actualBuckets[i]) / totalActual;
    const grad = p > 0 ? p / q : 0;
    if (i < n / 2) gradMuLow += grad * (i / n - 0.25);
    gradAlpha += grad * (i / n - 0.5);
  }

  const lr = learningRate;
  const newMuLow = Math.max(-1, Math.min(1, (prevParams.muLow ?? 0) + lr * gradMuLow));
  const newAlpha = Math.max(0.1, Math.min(2.0, (prevParams.alpha ?? 0.5) + lr * gradAlpha * 0.1));

  return {
    ...prevParams,
    muLow: newMuLow,
    alpha: newAlpha,
    sigmaMix: Math.max(0.3, Math.min(2.5, realizedSigma * 15)),
    muHigh: Math.log(Math.max(2, 1 + Math.abs(ratio) * 3)) * 0.6,
  };
}

// ---------------------------------------------------------------------------
// runAuction
// ---------------------------------------------------------------------------

const DEFAULT_BUCKET_COUNT = 10;

function makeBuckets(cap, n = DEFAULT_BUCKET_COUNT) {
  // Log-spaced leverage buckets from 0.5 to cap.
  const logMin = Math.log(0.5);
  const logMax = Math.log(Math.max(1, cap));
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    return Math.exp(logMin + t * (logMax - logMin));
  });
}

function buildCurve(bids, cap, smileParams, realizedSigma, metaParams) {
  if (!bids || bids.length === 0) return [];

  const bucketLevs = makeBuckets(cap);
  const n = bucketLevs.length;

  // Compute ratio: net directional tilt (-1 short, +1 long).
  const totalMargin = bids.reduce((s, b) => s + (b.base_margin ?? b.margin ?? 1000), 0) || 1;
  const ratio = bids.reduce((s, b) => {
    const w = (b.base_margin ?? b.margin ?? 1000) / totalMargin;
    return s + w * (b.strategy?.includes("LONG") ? 1 : -1);
  }, 0);

  // Ideal (geodesic) weight per bucket.
  const ideal = bucketLevs.map((bl) =>
    geodesicWeight(bl, ratio, realizedSigma, smileParams.sk, smileParams.ek, metaParams)
  );
  const idealSum = ideal.reduce((s, v) => s + v, 0) || 1;
  const idealNorm = ideal.map((v) => v / idealSum);

  // Actual margin distribution across buckets.
  const actual = new Array(n).fill(0);
  bids.forEach((bid) => {
    const lev = bid.max_lev ?? bid.leverage ?? 1;
    let closest = 0;
    let minDist = Infinity;
    bucketLevs.forEach((bl, i) => {
      const d = Math.abs(bl - lev);
      if (d < minDist) {
        minDist = d;
        closest = i;
      }
    });
    actual[closest] += bid.base_margin ?? bid.margin ?? 1000;
  });
  const actualSum = actual.reduce((s, v) => s + v, 0) || 1;
  const actualNorm = actual.map((v) => v / actualSum);

  return bucketLevs.map((bl, i) => ({
    lev: parseFloat(bl.toFixed(3)),
    ideal: parseFloat(idealNorm[i].toFixed(6)),
    actual: parseFloat(actualNorm[i].toFixed(6)),
  }));
}

// Match long and short users via the geodesic distribution.
// Returns matched pairs, filled leverage, and per-user yield estimates.
function matchBids(longBids, shortBids, cap, smileParams, realizedSigma, metaParams, normWeights, bucketLevs) {
  const matched = [];
  const logs = [];

  // Sub-unit cascade: try full match first, then fall back to fractional
  // leverage steps so thin books still clear when bid/ask leverage differ.
  const steps = [1, ...SUB_UNIT_STEPS];

  const sortedLong = [...longBids].sort((a, b) => (b.max_lev ?? 1) - (a.max_lev ?? 1));
  const sortedShort = [...shortBids].sort((a, b) => (b.max_lev ?? 1) - (a.max_lev ?? 1));

  let si = 0;
  for (const lb of sortedLong) {
    if (si >= sortedShort.length) break;
    const sb = sortedShort[si];

    // Start from the smaller of the two max-leverage offers, then cascade
    // down the sub-unit ladder until we find a fillable step >= 0.5.
    const baseLev = Math.min(lb.max_lev ?? 1, sb.max_lev ?? 1);
    let filledLev = 0;
    let stepFraction = 1;
    for (const s of steps) {
      const candidate = baseLev * s;
      if (candidate >= 0.5) {
        filledLev = candidate;
        stepFraction = s;
        break;
      }
    }

    if (filledLev < 0.5) {
      si++;
      continue;
    }

    const margin = Math.min(lb.base_margin ?? 1000, sb.base_margin ?? 1000) * stepFraction;

    const entMultL = getEntropyMultForUser(filledLev, normWeights, bucketLevs);
    const entMultS = getEntropyMultForUser(filledLev, normWeights, bucketLevs);

    const tipL = (lb.tip_tiers?.[0]?.tip ?? 0.02) * entMultL;
    const tipS = (sb.tip_tiers?.[0]?.tip ?? 0.02) * entMultS;

    matched.push({
      longId: lb.id,
      shortId: sb.id,
      leverage: parseFloat(filledLev.toFixed(3)),
      margin: parseFloat(margin.toFixed(2)),
      fillFraction: stepFraction,
      longTip: parseFloat(tipL.toFixed(4)),
      shortTip: parseFloat(tipS.toFixed(4)),
    });
    logs.push(
      `[MATCH] ${lb.id} LONG x${filledLev.toFixed(2)} ↔ ${sb.id} SHORT | margin=$${margin.toFixed(0)} fill=${(stepFraction * 100).toFixed(0)}% tipL=${(tipL * 100).toFixed(2)}%`
    );
    si++;
  }

  return { matched, logs };
}

// Full auction for one trading pair, one epoch.
//
// users         - array of participant bid objects (player + adapter flow)
// alpha         - current long/short ratio from previous epoch [0,1]
// logs          - mutable log array to push messages into
// cap           - effective leverage cap for this instrument
// smileParams   - { sk, ek } from blendSmileParams
// realizedSigma - rolling realized volatility
// prevSmoothFills - previous smoothed fill array (for entropy continuity)
// metaParams    - current geodesic meta-parameters
export function runAuction(
  users,
  alpha,
  logs,
  cap,
  smileParams,
  realizedSigma,
  prevSmoothFills,
  metaParams
) {
  const ratio = alpha * 2 - 1; // [-1,1]: negative = more shorts

  const longBids = users.filter(
    (u) => u.strategy === "FIXED_LONG" || (u.strategy === "YIELD_CHASER" && ratio >= 0)
  );
  const shortBids = users.filter(
    (u) => u.strategy === "FIXED_SHORT" || (u.strategy === "YIELD_CHASER" && ratio < 0)
  );

  // Zero-match short-circuit: if either side of the book is empty, nothing
  // can clear. Return a well-formed empty result so downstream consumers
  // (entropy contracts, strips, secondary markets) don't have to defend against
  // undefined/malformed auction state.
  if (longBids.length === 0 || shortBids.length === 0) {
    logs.push(
      `[AUCTION] No match: longBids=${longBids.length} shortBids=${shortBids.length} — skipping clear.`
    );
    return {
      matched: [],
      longCurve: [],
      shortCurve: [],
      dominantSide: longBids.length >= shortBids.length ? "LONG" : "SHORT",
      normWeights: [],
      smoothFills: prevSmoothFills ?? [],
      bucketLevs: [],
      smileParams: smileParams ?? { sk: 0, ek: 0 },
      metaParams: metaParams ?? {},
      imbalanceRatio: 1,
      softClose: true,
      totalMatched: 0,
      avgLev: 0,
    };
  }

  const liveSmile = estimateSmileParams([...longBids, ...shortBids], ratio);
  const blended = blendSmileParams(smileParams ?? { sk: 0, ek: 0 }, liveSmile);

  const longCurve = buildCurve(longBids, cap, blended, realizedSigma, metaParams);
  const shortCurve = buildCurve(shortBids, cap, blended, realizedSigma, metaParams);

  const dominantSide = longBids.length >= shortBids.length ? "LONG" : "SHORT";
  const dominantCurve = dominantSide === "LONG" ? longCurve : shortCurve;

  // Entropy weights from dominant side.
  const idealBuckets = dominantCurve.map((b) => b.ideal);
  const actualBuckets = dominantCurve.map((b) => b.actual);
  const bucketLevs = dominantCurve.map((b) => b.lev);

  const { normWeights, smoothFills } = calcEntropyWeights(
    idealBuckets,
    actualBuckets,
    prevSmoothFills
  );

  const updatedMeta = adaptMetaParams(metaParams ?? {}, actualBuckets, idealBuckets, ratio, realizedSigma);

  const { matched, logs: matchLogs } = matchBids(
    longBids,
    shortBids,
    cap,
    blended,
    realizedSigma,
    updatedMeta,
    normWeights,
    bucketLevs
  );
  matchLogs.forEach((l) => logs.push(l));

  const totalMatched = matched.length;
  const totalLongMargin = matched.reduce((s, m) => s + m.margin, 0);
  const avgLev = totalMatched > 0
    ? matched.reduce((s, m) => s + m.leverage, 0) / totalMatched
    : 0;

  // Soft-close: flag if imbalance breaches SOFT_CLOSE_PCT.
  const imbalanceRatio =
    longBids.length + shortBids.length > 0
      ? Math.abs(longBids.length - shortBids.length) /
        (longBids.length + shortBids.length)
      : 0;
  const softClose = imbalanceRatio > SOFT_CLOSE_PCT;

  if (softClose) {
    logs.push(
      `[AUCTION] Soft-close triggered: imbalance=${(imbalanceRatio * 100).toFixed(1)}%`
    );
  }

  logs.push(
    `[AUCTION] ${totalMatched} matches | avgLev=${avgLev.toFixed(2)}x | longMargin=$${totalLongMargin.toFixed(0)} | softClose=${softClose}`
  );

  return {
    matched,
    longCurve,
    shortCurve,
    dominantSide,
    normWeights,
    smoothFills,
    bucketLevs,
    smileParams: blended,
    metaParams: updatedMeta,
    imbalanceRatio,
    softClose,
    totalMatched,
    avgLev,
  };
}
