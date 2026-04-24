// Pool-deposit LTV — "how much of your insurance pool deposit can be
// extracted as credit, based on how diversified your LAP book is."
//
// The LTV is NOT a property of the pool deposit itself — it's a property
// of the whole portfolio, evaluated from the pool's perspective. A
// perfectly diversified book lets you extract the full deposit as credit
// (LTV 1.0); a single concentrated position means the deposit is at
// higher risk and only a fraction can be hypothecated (LTV floor = 0.30).
//
// Inputs come from existing composition primitives in credit.js (HHI,
// asset-class count, max-weight), so the semantics stay consistent with
// the rest of the credit system.

import { PAIRS, ASSET_CLASSES } from "../constants/assets.js";

// Tuned so that:
//   - no positions → 0.30 (floor, untested book)
//   - 1 big position → ~0.35
//   - 3 classes roughly balanced → ~0.80-0.85
//   - 5+ classes balanced → 1.00 (ceiling)
export const POOL_LTV_FLOOR = 0.30;
export const POOL_LTV_CEILING = 1.00;
export const POOL_LTV_DIVERSITY_WEIGHT = 0.45; // Shannon-entropy contribution
export const POOL_LTV_CONCENTRATION_WEIGHT = 0.35; // 1 − HHI contribution
export const POOL_LTV_MAXWEIGHT_PENALTY = 0.25; // max single-position penalty

// Portfolio-derived pool LTV.
//
// `positions` is the full open-position list (pool-backed AND direct). We
// score the whole book, not just pool-backed positions — "diversified"
// describes the user's behavior as a trader, regardless of funding source.
export function calcPoolLtv(positions = []) {
  const raw = calcPoolLtvRaw(positions);
  return {
    ltv: parseFloat(raw.ltv.toFixed(4)),
    breakdown: {
      floor: parseFloat(raw.floor.toFixed(4)),
      diversityComponent: parseFloat(raw.diversityComponent.toFixed(4)),
      concentrationComponent: parseFloat(raw.concentrationComponent.toFixed(4)),
      maxWeightPenalty: parseFloat(raw.maxWeightPenalty.toFixed(4)),
    },
    stats: {
      numPositions: positions.length,
      numAssetClasses: raw.numAssetClasses,
      hhi: parseFloat(raw.hhi.toFixed(4)),
      maxWeight: parseFloat(raw.maxWeight.toFixed(4)),
      shannonNorm: parseFloat(raw.shannonNorm.toFixed(4)),
    },
  };
}

function calcPoolLtvRaw(positions) {
  const empty = {
    ltv: POOL_LTV_FLOOR,
    floor: POOL_LTV_FLOOR,
    diversityComponent: 0,
    concentrationComponent: 0,
    maxWeightPenalty: 0,
    numAssetClasses: 0,
    hhi: 1,
    maxWeight: 1,
    shannonNorm: 0,
  };

  if (!positions || positions.length === 0) return empty;

  const total = positions.reduce((s, p) => s + (p.margin ?? 0), 0);
  if (total <= 0) return empty;

  // Aggregate weight by pair (so long+short hedges on one pair count as one slot).
  const perPair = {};
  const perClass = {};
  positions.forEach((p) => {
    const w = (p.margin ?? 0) / total;
    perPair[p.pairKey] = (perPair[p.pairKey] ?? 0) + w;
    const cls = PAIRS[p.pairKey]?.assetClass ?? "UNKNOWN";
    perClass[cls] = (perClass[cls] ?? 0) + w;
  });

  const pairWeights = Object.values(perPair);
  const hhi = pairWeights.reduce((s, w) => s + w * w, 0);
  const maxWeight = Math.max(...pairWeights);

  // Shannon entropy over asset classes, normalised by log(n_classes_possible).
  // Uses the number of classes actually in the book as the normaliser —
  // two evenly-split classes is "fully diverse across the 2 you chose" but
  // doesn't reach the ceiling; that requires spreading across more classes.
  const classWeights = Object.values(perClass);
  const totalClassPool = Object.keys(ASSET_CLASSES).length || 1;
  const shannon = classWeights.reduce(
    (s, w) => (w > 0 ? s - w * Math.log(w) : s),
    0
  );
  const shannonNorm = shannon / Math.log(totalClassPool);

  // Concentration component — (1 − HHI) scaled. Flat portfolio of 5 equal
  // pairs has HHI 0.2, so (1 − 0.2) = 0.8; single position has HHI 1 → 0.
  const concentrationComponent =
    POOL_LTV_CONCENTRATION_WEIGHT * Math.max(0, Math.min(1, 1 - hhi));

  // Diversity component — Shannon over asset classes, already in [0, 1].
  const diversityComponent =
    POOL_LTV_DIVERSITY_WEIGHT * Math.max(0, Math.min(1, shannonNorm));

  // Max-weight penalty — any single position bigger than 50% eats LTV.
  // Linear from 0 at maxWeight=0.5 up to the full penalty at maxWeight=1.0.
  const overflow = Math.max(0, maxWeight - 0.5) / 0.5;
  const maxWeightPenalty = POOL_LTV_MAXWEIGHT_PENALTY * overflow;

  const ltv = Math.max(
    POOL_LTV_FLOOR,
    Math.min(
      POOL_LTV_CEILING,
      POOL_LTV_FLOOR +
        concentrationComponent +
        diversityComponent -
        maxWeightPenalty
    )
  );

  return {
    ltv,
    floor: POOL_LTV_FLOOR,
    diversityComponent,
    concentrationComponent,
    maxWeightPenalty,
    numAssetClasses: Object.keys(perClass).length,
    hhi,
    maxWeight,
    shannonNorm,
  };
}

// Available pool credit: deposit × LTV − already-deployed credit.
export function calcAvailablePoolCredit(depositAmount, positions, deployedCredit = 0) {
  if (!depositAmount || depositAmount <= 0) return 0;
  const { ltv } = calcPoolLtv(positions);
  const budget = depositAmount * ltv;
  return Math.max(0, budget - deployedCredit);
}

// Whether the current book + deployed credit is still within the budget.
// If false, the next epoch should deleverage.
export function isOverCreditBudget(depositAmount, positions, deployedCredit) {
  if (!depositAmount || depositAmount <= 0) return deployedCredit > 0;
  const { ltv } = calcPoolLtv(positions);
  return deployedCredit > depositAmount * ltv + 1e-6;
}
