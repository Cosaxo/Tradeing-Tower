import { ASSET_CLASSES, PAIRS } from "../constants/assets.js";
import { EPOCH_DT_DAYS, INSURANCE_K } from "../constants/system.js";

export function getEsmaCap(pairKey) {
  return ASSET_CLASSES[PAIRS[pairKey]?.assetClass]?.esmaMaxLev ?? 2;
}

// Vol-adaptive effective cap: min(ESMA, 1 / (sigma_realized * sqrt(t) * K))
export function getEffectiveCap(pairKey, realizedSigma) {
  const esmaCap = getEsmaCap(pairKey);
  const sigma = realizedSigma || PAIRS[pairKey]?.sigma || 0.02;
  const volCap = Math.max(1, 1 / (sigma * Math.sqrt(EPOCH_DT_DAYS) * INSURANCE_K));
  const effectiveCap = Math.min(esmaCap, volCap);
  const bindingConstraint = volCap < esmaCap ? "VOL" : "ESMA";
  return {
    esmaCap,
    volCap: parseFloat(volCap.toFixed(1)),
    effectiveCap: parseFloat(effectiveCap.toFixed(1)),
    bindingConstraint,
  };
}
