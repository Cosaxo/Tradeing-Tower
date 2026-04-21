// Pure math + statistics helpers. No React, no DOM, no module-level state.

export function boxMuller() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// Lightweight classnames-style helper.
export function cx(...args) {
  return args.filter(Boolean).join(" ");
}

// Sortino ratio at a target return.
export function sortino(returns, target = 0) {
  if (!returns || returns.length < 3) return null;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const down = returns.filter((r) => r < target);
  if (!down.length) return mean > 0 ? 99.9 : 0;
  const dev = Math.sqrt(down.reduce((s, r) => s + (r - target) ** 2, 0) / down.length);
  return dev > 0 ? (mean - target) / dev : 0;
}

export function calcVolatility(returns) {
  if (!returns || returns.length < 2) return 0;
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

export function calcCalmar(returns, maxDD) {
  if (!returns || !returns.length) return null;
  if (!Number.isFinite(maxDD) || maxDD === 0) return null;
  const annualised = (returns.reduce((s, r) => s + r, 0) / returns.length) * 365;
  const calmar = annualised / maxDD;
  return Number.isFinite(calmar) ? calmar : null;
}

export function calcWinRate(returns) {
  if (!returns || !returns.length) return null;
  return returns.filter((r) => r > 0).length / returns.length;
}

export function calcMaxDrawdown(history) {
  const margins = history.map((s) => s.users?.find((u) => u.id === "You")?.margin ?? 5000);
  let peak = margins[0] ?? 5000;
  let maxDD = 0;
  margins.forEach((m) => {
    if (m > peak) peak = m;
    // Guard against peak=0 (e.g. fully liquidated equity) which would
    // otherwise yield NaN and silently fail downstream gate comparisons.
    if (peak > 0) {
      const dd = (peak - m) / peak;
      if (dd > maxDD) maxDD = dd;
    }
  });
  return maxDD;
}

export function calcReturns(history) {
  return history.slice(1).map((s, i) => {
    const prev = history[i].users?.find((u) => u.id === "You")?.margin ?? 5000;
    const curr = s.users?.find((u) => u.id === "You")?.margin ?? 5000;
    return prev > 0 ? (curr - prev) / prev : 0;
  });
}

export function calcCorrelation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 3) return 0;
  const ax = a.slice(-n);
  const bx = b.slice(-n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  const num = ax.reduce((s, v, i) => s + (v - ma) * (bx[i] - mb), 0);
  const da = Math.sqrt(ax.reduce((s, v) => s + (v - ma) ** 2, 0));
  const db = Math.sqrt(bx.reduce((s, v) => s + (v - mb) ** 2, 0));
  return da * db > 0 ? num / (da * db) : 0;
}

// Loyalty multiplier: caps at 1.4x after 20 epochs.
export function timeWeightedYieldMult(epochsHeld) {
  return 1 + 0.4 * Math.min(Math.max(0, epochsHeld), 20) / 20;
}

// Realized volatility: rolling std of last N log price returns.
export function calcRealizedSigma(priceHistory, window = 12) {
  const prices = priceHistory.slice(-window - 1);
  if (prices.length < 3) return 0.02;
  const returns = prices.slice(1).map((p, i) => Math.log(p / prices[i]));
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance);
}

// Ratio-beta: covariance of log(ratio) with |returns|, normalised by var(log(ratio)).
// Used for ratio-correlated volatility amplification (§4.6).
export function calcRatioBeta(ratioHistory, returnHistory) {
  const n = Math.min(ratioHistory?.length ?? 0, returnHistory?.length ?? 0);
  if (n < 5) return 0;
  const ratios = ratioHistory.slice(-n).map((r) => Math.log(Math.max(0.01, r)));
  const absR = returnHistory.slice(-n).map(Math.abs);
  const meanR = ratios.reduce((s, v) => s + v, 0) / n;
  const meanA = absR.reduce((s, v) => s + v, 0) / n;
  const cov = ratios.reduce((s, v, i) => s + (v - meanR) * (absR[i] - meanA), 0) / n;
  const varR = ratios.reduce((s, v) => s + (v - meanR) ** 2, 0) / n;
  if (varR <= 1e-8) return 0;
  return Math.max(0, Math.min(1, cov / varR));
}

// Effective vol with ratio amplification (§4.6):
//   σ_eff = σ · (1 + β · log(ratio))
// Crowded books are structurally more fragile → tighter caps, earlier flags.
export function ratioEffectiveSigma(realizedSigma, ratio, beta = 0.3) {
  if (!Number.isFinite(ratio) || ratio <= 0) return realizedSigma;
  const amp = 1 + beta * Math.log(ratio);
  return realizedSigma * Math.max(0.5, amp);
}
