// Geometric settlement + deterministic analytical barrier checks (Harrison 1985).
// No Math.random() appears in this module so settlement is 100% reproducible
// given the same price path inputs.

// Exact geometric PnL for a leveraged position.
export function geometricPnl(margin, leverage, priceOld, priceNew, side) {
  if (priceOld <= 0 || leverage === 0) return 0;
  const logReturn = Math.log(priceNew / priceOld);
  const direction = side === "LONG" ? 1 : -1;
  return margin * leverage * (Math.exp(direction * logReturn) - 1);
}

// Probability that a Brownian bridge from log(P_old) to log(P_new) touches the
// log-barrier at log(P_liq) and the expected loss under that event.
//
// For a Brownian bridge over [0, T] with end-points log(P_old) and log(P_new)
// the probability of first-passage to a barrier is:
//
//     P(tau <= T) = exp(-2 * a * b / sigma^2)
//
// where a and b are signed log-distances to the barrier from start and end.
//
// Reference: Harrison (1985) Brownian Motion and Stochastic Flow Systems.
export function deterministicBarrierAdjustment(priceOld, priceNew, sigma, leverage, margin, side) {
  if (leverage <= 0.25 || margin <= 0 || sigma <= 0) {
    return { probTouch: 0, adjustedMargin: margin };
  }

  const safetyFactor = 0.9;
  const direction = side === "LONG" ? 1 : -1;
  const pLiq = priceOld * (1 - (direction * safetyFactor) / leverage);

  // Endpoint already past barrier - apply full geometric loss to the barrier.
  const endpointPastBarrier = side === "LONG" ? priceNew <= pLiq : priceNew >= pLiq;
  if (endpointPastBarrier) {
    const moveToBreach = Math.abs(pLiq - priceOld) / priceOld;
    const partialMargin = Math.max(0, margin - leverage * moveToBreach * margin * 1.05);
    return { probTouch: 1, adjustedMargin: partialMargin };
  }

  const logP0 = Math.log(priceOld);
  const logPT = Math.log(priceNew);
  const logPliq = Math.log(Math.max(1e-10, pLiq));

  const a = direction * (logP0 - logPliq);
  const b = direction * (logPT - logPliq);

  if (a <= 0) return { probTouch: 1, adjustedMargin: 0 };

  const sigmaEpoch = Math.max(0.001, sigma);
  const exponent = (-2 * a * b) / (sigmaEpoch * sigmaEpoch);
  const probTouch = Math.min(1, Math.max(0, Math.exp(exponent)));

  if (probTouch < 1e-8) return { probTouch: 0, adjustedMargin: margin };

  const moveAtBarrier = Math.abs(pLiq - priceOld) / priceOld;
  const marginAtBarrier = Math.max(0, margin - leverage * moveAtBarrier * margin * 1.05);
  const lossAtBarrier = margin - marginAtBarrier;
  const expectedLoss = probTouch * lossAtBarrier;
  const adjustedMargin = Math.max(0, margin - expectedLoss);

  return { probTouch, adjustedMargin };
}

// Lending settlement: lender earns rental rate on lent exposure; borrower
// takes the price risk.
export function calcLendingSettlement(lender, borrower, priceOld, priceNew, rentalRate, sigma) {
  const logRet = Math.log(priceNew / priceOld);
  const lendedExp = borrower.borrowedExposure || 0;
  const ownExp = lender.allocatedExposure - lendedExp;
  const lenderOwnPnl = ownExp * (Math.exp(lender.side === "LONG" ? logRet : -logRet) - 1);
  const rentalIncome = lendedExp * rentalRate;
  const lenderNetPnl = lenderOwnPnl + rentalIncome;

  const barrierResult = deterministicBarrierAdjustment(
    priceOld,
    priceNew,
    sigma,
    lendedExp / Math.max(1, borrower.margin),
    borrower.margin,
    borrower.borrowSide || "LONG"
  );
  const borrowerGrossPnl =
    lendedExp * (Math.exp(borrower.borrowSide === "LONG" ? logRet : -logRet) - 1);
  const borrowerNetPnl =
    barrierResult.probTouch > 0.5
      ? barrierResult.adjustedMargin - borrower.margin - rentalIncome
      : borrowerGrossPnl - rentalIncome;

  return {
    lenderNetPnl,
    borrowerNetPnl,
    rentalIncome,
    barrierProb: barrierResult.probTouch,
  };
}
