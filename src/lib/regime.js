// Market regime detection from three signals:
//   - trend:    average sign of returns over last 20 epochs
//   - volRatio: sigma_5 / sigma_20  (short-term vs long-term vol)
//   - autocorr: lag-1 autocorrelation of returns
//
// Each regime adjusts sigma_geo and mu_log scaling in the geodesic
// distribution, and NPC behaviour.

export const REGIMES = {
  CALM: { label: "Calm", color: "#34d399", sigmaAdj: 1.2, muAdj: 1.0 },
  TRENDING_UP: { label: "Trending Up", color: "#60a5fa", sigmaAdj: 0.9, muAdj: 1.15 },
  TRENDING_DN: { label: "Trending Down", color: "#f87171", sigmaAdj: 0.85, muAdj: 0.7 },
  HIGH_VOL: { label: "High Vol", color: "#fbbf24", sigmaAdj: 0.7, muAdj: 0.85 },
  CRASH: { label: "Crash", color: "#ef4444", sigmaAdj: 0.5, muAdj: 0.5 },
  MEAN_REVERT: { label: "Mean-Revert", color: "#a78bfa", sigmaAdj: 1.1, muAdj: 1.0 },
};

export function detectRegime(returnHistory) {
  if (!returnHistory || returnHistory.length < 10) {
    return { key: "CALM", ...REGIMES.CALM, trend: 0, volRatio: 1, autocorr: 0 };
  }

  const recent20 = returnHistory.slice(-20);
  const recent5 = returnHistory.slice(-5);

  const trend = recent20.reduce((s, r) => s + Math.sign(r), 0) / recent20.length;

  const sigma20 =
    Math.sqrt(recent20.reduce((s, r) => s + r * r, 0) / recent20.length) || 0.001;
  const sigma5 =
    Math.sqrt(recent5.reduce((s, r) => s + r * r, 0) / recent5.length) || 0.001;
  const volRatio = sigma5 / sigma20;

  const mean = recent20.reduce((s, r) => s + r, 0) / recent20.length;
  const cov1 =
    recent20.slice(1).reduce((s, r, i) => s + (r - mean) * (recent20[i] - mean), 0) /
    (recent20.length - 1);
  const variance = recent20.reduce((s, r) => s + (r - mean) ** 2, 0) / recent20.length;
  const autocorr = variance > 0 ? cov1 / variance : 0;

  let key;
  if (volRatio > 2.0 && trend < -0.3) key = "CRASH";
  else if (volRatio > 1.5) key = "HIGH_VOL";
  else if (trend > 0.4) key = "TRENDING_UP";
  else if (trend < -0.4) key = "TRENDING_DN";
  else if (autocorr < -0.3) key = "MEAN_REVERT";
  else key = "CALM";

  return { key, ...REGIMES[key], trend, volRatio, autocorr };
}
