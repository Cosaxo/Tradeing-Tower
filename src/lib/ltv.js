// Pool-deposit LTV — "how much of your insurance pool deposit can be
// extracted as credit, based on how *structurally safe* your LAP book is."
//
// The LTV is NOT a property of the pool deposit itself — it's a property
// of the whole portfolio, evaluated from the pool's perspective. A safe,
// well-built book lets you extract the full deposit as credit (LTV 1.0);
// a single concentrated position (or none at all) means the deposit is
// at higher risk and only a fraction can be hypothecated (LTV floor 0.30).
//
// Five additive terms after the legacy-credit fold-in:
//
//   - concentration : 1 − HHI on per-pair capital share
//   - diversity     : Shannon entropy over asset classes (normalised)
//   - tailCoverage  : fraction of book in hedgeChar > threshold assets
//   - discipline    : 1 − avg(leverage / esma cap)
//   minus
//   - maxWeight     : single-position dominance penalty
//
// `tailCoverage` and `discipline` came from the legacy composition score
// — they measure structural safety (does the book have crisis hedges?
// is it underleveraged relative to caps?), exactly the right input for
// LTV. Keeping them and dropping the legacy code's performance gates,
// drift detection, and parallel multiplier collapses two systems into
// one consistent story.

import { PAIRS, ASSET_CLASSES } from "../constants/assets.js";

// Tuned so that:
//   - no positions → 0.30 (floor, untested book)
//   - 1 big position → ~0.30
//   - 3 classes balanced + tail hedge → ~0.85
//   - 5+ classes balanced + low leverage + tail hedge → 1.00
export const POOL_LTV_FLOOR = 0.30;
export const POOL_LTV_CEILING = 1.00;

// Term weights (must sum to ~POOL_LTV_CEILING − POOL_LTV_FLOOR = 0.70 so a
// perfect book reaches the ceiling).
export const POOL_LTV_W_CONCENTRATION = 0.20;
export const POOL_LTV_W_DIVERSITY = 0.25;
export const POOL_LTV_W_TAIL = 0.15;
export const POOL_LTV_W_DISCIPLINE = 0.10;
export const POOL_LTV_MAXWEIGHT_PENALTY = 0.20;

// Tail-coverage specifics (formerly credit.js constants).
export const POOL_LTV_TAIL_COVERAGE_TARGET = 0.15;
export const POOL_LTV_TAIL_HEDGE_THRESHOLD = 0.3;

// Portfolio-derived pool LTV.
//
// `positions` is the full open-position list (pool-backed AND direct). We
// score the whole book, not just pool-backed positions — "diversified +
// hedged + disciplined" describes the user's behavior as a trader,
// regardless of funding source.
export function calcPoolLtv(positions = []) {
  const raw = calcPoolLtvRaw(positions);
  return {
    ltv: parseFloat(raw.ltv.toFixed(4)),
    breakdown: {
      floor: parseFloat(raw.floor.toFixed(4)),
      concentrationComponent: parseFloat(raw.concentrationComponent.toFixed(4)),
      diversityComponent: parseFloat(raw.diversityComponent.toFixed(4)),
      tailComponent: parseFloat(raw.tailComponent.toFixed(4)),
      disciplineComponent: parseFloat(raw.disciplineComponent.toFixed(4)),
      maxWeightPenalty: parseFloat(raw.maxWeightPenalty.toFixed(4)),
    },
    stats: {
      numPositions: positions.length,
      numAssetClasses: raw.numAssetClasses,
      hhi: parseFloat(raw.hhi.toFixed(4)),
      maxWeight: parseFloat(raw.maxWeight.toFixed(4)),
      shannonNorm: parseFloat(raw.shannonNorm.toFixed(4)),
      tailFraction: parseFloat(raw.tailFraction.toFixed(4)),
      avgLeverageFraction: parseFloat(raw.avgLeverageFraction.toFixed(4)),
    },
  };
}

function calcPoolLtvRaw(positions) {
  const empty = {
    ltv: POOL_LTV_FLOOR,
    floor: POOL_LTV_FLOOR,
    concentrationComponent: 0,
    diversityComponent: 0,
    tailComponent: 0,
    disciplineComponent: 0,
    maxWeightPenalty: 0,
    numAssetClasses: 0,
    hhi: 1,
    maxWeight: 1,
    shannonNorm: 0,
    tailFraction: 0,
    avgLeverageFraction: 0,
  };

  if (!positions || positions.length === 0) return empty;

  const total = positions.reduce((s, p) => s + (p.margin ?? 0), 0);
  if (total <= 0) return empty;

  // Aggregate weight by pair (long+short hedges on one pair → one slot)
  // and by asset class.
  const perPair = {};
  const perClass = {};
  let tailWeight = 0;
  let avgLevFraction = 0;
  positions.forEach((p) => {
    const w = (p.margin ?? 0) / total;
    const pair = PAIRS[p.pairKey];
    perPair[p.pairKey] = (perPair[p.pairKey] ?? 0) + w;
    const cls = pair?.assetClass ?? "UNKNOWN";
    perClass[cls] = (perClass[cls] ?? 0) + w;

    if ((pair?.hedgeChar ?? 0) > POOL_LTV_TAIL_HEDGE_THRESHOLD) {
      tailWeight += w;
    }

    const esmaCap = ASSET_CLASSES[cls]?.esmaMaxLev ?? 2;
    avgLevFraction += Math.min(1, (p.leverage ?? 1) / esmaCap) / positions.length;
  });

  const pairWeights = Object.values(perPair);
  const hhi = pairWeights.reduce((s, w) => s + w * w, 0);
  const maxWeight = Math.max(...pairWeights);

  // Shannon entropy over asset classes, normalised by log of the asset-class
  // pool size (not the count actually used). This way "two evenly-split
  // classes" doesn't reach the ceiling — you have to spread across more.
  const classWeights = Object.values(perClass);
  const totalClassPool = Object.keys(ASSET_CLASSES).length || 1;
  const shannon = classWeights.reduce(
    (s, w) => (w > 0 ? s - w * Math.log(w) : s),
    0
  );
  const shannonNorm = shannon / Math.log(totalClassPool);

  // Concentration: (1 − HHI). Five equal pairs → HHI 0.2 → 0.8.
  const concentrationComponent =
    POOL_LTV_W_CONCENTRATION * Math.max(0, Math.min(1, 1 - hhi));

  // Diversity: Shannon over the asset-class pool.
  const diversityComponent =
    POOL_LTV_W_DIVERSITY * Math.max(0, Math.min(1, shannonNorm));

  // Tail coverage: fraction of book in hedgeChar > 0.3 assets, normalised
  // against the 15% target.
  const tailFraction = tailWeight;
  const tailComponent =
    POOL_LTV_W_TAIL * Math.min(1, tailFraction / POOL_LTV_TAIL_COVERAGE_TARGET);

  // Discipline: 1 − avg(leverage / esma cap). Empty book treated as fully
  // disciplined (handled above by short-circuit return).
  const disciplineComponent =
    POOL_LTV_W_DISCIPLINE * Math.max(0, Math.min(1, 1 - avgLevFraction));

  // Max-weight penalty: any single position larger than 50% eats LTV.
  const overflow = Math.max(0, maxWeight - 0.5) / 0.5;
  const maxWeightPenalty = POOL_LTV_MAXWEIGHT_PENALTY * overflow;

  const ltv = Math.max(
    POOL_LTV_FLOOR,
    Math.min(
      POOL_LTV_CEILING,
      POOL_LTV_FLOOR +
        concentrationComponent +
        diversityComponent +
        tailComponent +
        disciplineComponent -
        maxWeightPenalty
    )
  );

  return {
    ltv,
    floor: POOL_LTV_FLOOR,
    concentrationComponent,
    diversityComponent,
    tailComponent,
    disciplineComponent,
    maxWeightPenalty,
    numAssetClasses: Object.keys(perClass).length,
    hhi,
    maxWeight,
    shannonNorm,
    tailFraction,
    avgLeverageFraction: avgLevFraction,
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
