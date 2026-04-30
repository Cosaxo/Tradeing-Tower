// Paired LAP — single object holding both directional legs of one pair
// at the same leverage. Net price exposure is structurally zero, so the
// position is delta-neutral; P&L comes from the convexity (positive
// gamma) of holding both sides + auction tip income from filling both
// sides of the match.
//
// Phase-2 scope: open / close / settle as one atomic unit. Phase 3 adds
// the rental market that lets the owner lease one or both legs out for
// a per-epoch tip stream (which is when the position becomes
// economically attractive to hold).
//
// Data model
// ----------
//
//   {
//     id,                              // stable identifier "PLAP-..."
//     type: "paired",
//     pairKey,                         // shared by both legs
//     margin,                          // TOTAL funded; each leg gets margin/2
//     leverage,                        // applies symmetrically to both legs
//     openPrice,
//     openedAtEpoch,
//     poolLinkage: null | {...},       // unchanged from single LAP
//     legs: {
//       long:  { rentedTo, rentalTipRate, rentalMargin, rentedAtEpoch }, // Phase 3
//       short: { ...same shape... },
//     },
//   }
//
// Margin convention: `margin` is the SUM of both legs' funded margin.
// Each leg therefore operates on `margin / 2` of capital. Notional per
// leg = (margin / 2) × leverage. Total notional held across both legs =
// margin × leverage.

let _idCounter = 0;
const _legShape = () => ({
  rentedTo: null,
  rentalTipRate: null,
  rentalMargin: 0,
  rentedAtEpoch: null,
});

export function makePairedLapId() {
  _idCounter += 1;
  return `PLAP-${Date.now().toString(36)}-${_idCounter.toString(36)}`;
}

// Build a paired LAP shape from open-time inputs. Pure factory; doesn't
// touch any state. Caller is responsible for reserving the underlying
// margin (direct path) or pool credit (pool-backed path) for both legs.
export function makePairedLap({
  pairKey,
  margin,                  // total, both legs combined
  leverage,
  openPrice,
  openedAtEpoch = 0,
  poolLinkage = null,
  id = null,
}) {
  return {
    id: id ?? makePairedLapId(),
    type: "paired",
    pairKey,
    margin,
    leverage,
    openPrice,
    openedAtEpoch,
    poolLinkage,
    legs: { long: _legShape(), short: _legShape() },
  };
}

export function isPairedLap(pos) {
  return pos != null && pos.type === "paired";
}

// Net P&L on closing a paired LAP at `currentPrice`. Long leg gains
// when price rises; short leg loses by the same multiplicative factor.
// The two cancel in linear order; what remains is gamma (positive) —
// always non-negative, peaking with volatility, modulo barrier hits
// (not modeled in Phase 2; barrier-assisted liquidation comes later).
//
// Decomposes the net into the two legs so callers can attribute P&L
// per leg if needed (rental will need this).
export function calcPairedLapClosePnl(pos, currentPrice) {
  if (!isPairedLap(pos)) {
    throw new Error("calcPairedLapClosePnl: position is not paired");
  }
  const openPrice = pos.openPrice ?? currentPrice;
  if (!Number.isFinite(openPrice) || openPrice <= 0) {
    return { longPnl: 0, shortPnl: 0, netPnl: 0 };
  }

  const logRet = Math.log(currentPrice / openPrice);
  const legMargin = (pos.margin ?? 0) / 2;
  const lev = pos.leverage ?? 1;

  // Each leg's P&L mirrors the single-LAP formula, applied to half the margin.
  const longPnl = legMargin * lev * (Math.exp(logRet) - 1);
  const shortPnl = legMargin * lev * (Math.exp(-logRet) - 1);
  const netPnl = longPnl + shortPnl;

  return { longPnl, shortPnl, netPnl };
}

// Total capital reserved for a paired LAP (both legs) — alias for
// `pos.margin` but named for clarity at call sites that distinguish
// "per-leg" vs "total" math.
export function totalPairedMargin(pos) {
  return isPairedLap(pos) ? (pos.margin ?? 0) : 0;
}

// Per-leg margin. Useful for settlement and rental accounting.
export function legMargin(pos) {
  return isPairedLap(pos) ? (pos.margin ?? 0) / 2 : 0;
}

// True if either leg is currently leased to a renter. Phase 2: always
// false (no rental yet). Defined here so consumers can call it without
// branching on phase.
export function hasActiveRental(pos) {
  if (!isPairedLap(pos)) return false;
  return Boolean(pos.legs?.long?.rentedTo) || Boolean(pos.legs?.short?.rentedTo);
}
