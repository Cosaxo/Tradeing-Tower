// Market-implied yield model.
//
// The equilibrium yield level and mean-reversion speed are estimated from
// observed yield history via EMA and lag-1 autocorrelation. No hardcoded
// equilibrium.
//
// Phase 5 trim: this module previously hosted strip pricing, jump-
// adjusted sigma, dynamic-buffer rate, and yield-buffer contribution
// helpers. All four became dead with the strip + yield-buffer removal
// and have been deleted. Only the auction-loop's yield-EMA estimator
// remains.

export function updateYieldModel(prev, currentYield) {
  const alpha = 0.05;
  const yieldEq = prev.yieldEq * (1 - alpha) + currentYield * alpha;
  const yieldChange = currentYield - prev.prevYield;
  const newAcov = prev.acov * 0.95 + yieldChange * prev.prevChange * 0.05;
  const newVar = prev.yieldVar * 0.95 + yieldChange * yieldChange * 0.05;
  const rho1 = newVar > 0 ? Math.max(-0.99, Math.min(0.99, newAcov / newVar)) : 0;
  const kappa = Math.max(
    0.01,
    Math.min(0.5, -Math.log(Math.max(0.01, 1 - Math.abs(rho1))))
  );
  return {
    yieldEq,
    kappa,
    prevYield: currentYield,
    prevChange: yieldChange,
    acov: newAcov,
    yieldVar: newVar,
  };
}
