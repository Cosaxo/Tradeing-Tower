import { boxMuller } from "./math.js";

// Class-specific stochastic price processes.
//
// Different asset classes have fundamentally different distributional
// properties. Using the same GBM skeleton for all instruments is statistically
// wrong, so this module dispatches to the right process per asset class.
//
// - CRYPTO:     GBM + Poisson jump component (Merton model)
// - VOLATILITY: asymmetric CIR-style mean-reversion
// - COMMODITY:  GBM with slow mean-reversion and occasional shocks
// - GOLD:       near-GBM with safe-haven premium
// - FX_MAJOR:   standard GBM (closest to Gaussian empirically)
// - INDEX/STOCK: GBM with leverage effect (vol rises when price falls)

// Standard geometric Brownian motion.
export function gbmStep(price, mu, sigma) {
  return price * Math.exp(mu - 0.5 * sigma * sigma + sigma * boxMuller());
}

// Merton jump-diffusion. Poisson-distributed jump count approximated as
// Bernoulli for small lambda.
export function gbmStepWithJumps(price, mu, sigma, jumpIntensity = 0.04, jumpSigma = 0.06) {
  const diffusive = mu - 0.5 * sigma * sigma + sigma * boxMuller();
  const jump = Math.random() < jumpIntensity ? jumpSigma * boxMuller() : 0;
  return price * Math.exp(diffusive + jump);
}

// Asymmetric CIR-style mean-reversion for VIX / VSTOXX: spikes fast, decays
// slow, producing the strong negative skew seen in empirical data.
export function gbmStepMeanReverting(price, mu, sigma, meanLevel, speed = 0.15) {
  const noise = boxMuller();
  const asymSpeed = price < meanLevel ? speed * 2.5 : speed * 0.6;
  const drift = asymSpeed * (meanLevel - price) + mu * price;
  const volOfVol = sigma * Math.sqrt(Math.max(0.1, price / meanLevel));
  return Math.max(5, price + drift + volOfVol * price * noise);
}

// Commodity GBM with slow mean-reversion and supply/demand shocks.
export function gbmStepCommodity(price, mu, sigma, meanLevel) {
  const noise = boxMuller();
  const speed = 0.03;
  const drift = (speed * (meanLevel - price) * price) / meanLevel + mu * price;
  const shock =
    Math.random() < 0.03 ? (Math.random() > 0.5 ? 1 : -1) * sigma * 2 * Math.abs(boxMuller()) : 0;
  return Math.max(
    0.001,
    price * Math.exp(drift / price - 0.5 * sigma * sigma + sigma * noise) * (1 + shock)
  );
}

// Leverage-effect GBM: when price falls, implied vol rises.
export function gbmStepWithLeverageEffect(price, mu, sigma, hedgeChar) {
  const noise = boxMuller();
  const leverageAmp = 1 - hedgeChar * Math.min(0, noise) * 0.3;
  const adjustedSigma = sigma * Math.max(0.5, leverageAmp);
  return price * Math.exp(
    mu - 0.5 * adjustedSigma * adjustedSigma + adjustedSigma * noise
  );
}

// Master dispatcher: pick the right process for each asset class.
export function priceStep(cfg, price, realizedSigma) {
  const sigma = realizedSigma || cfg.sigma;
  switch (cfg.assetClass) {
    case "CRYPTO":
      return gbmStepWithJumps(price, cfg.mu, sigma, 0.04, Math.max(0.04, sigma * 2.5));
    case "VOLATILITY":
      return gbmStepMeanReverting(price, cfg.mu, sigma, cfg.meanLevel ?? 20);
    case "COMMODITY":
      return gbmStepCommodity(price, cfg.mu, sigma, cfg.startPrice);
    case "GOLD":
      return gbmStep(price, cfg.mu, sigma);
    case "INDEX_MAJOR":
    case "INDEX_MINOR":
    case "STOCK":
      return gbmStepWithLeverageEffect(price, cfg.mu, sigma, cfg.hedgeChar ?? -0.2);
    default:
      return gbmStep(price, cfg.mu, sigma);
  }
}
