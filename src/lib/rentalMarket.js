// Rental market for paired-LAP legs.
//
// When the owner of a paired LAP wants to monetize one or both legs
// without taking the directional risk themselves, they publish a
// rental offer. Renters (sourced via the order-flow adapter) submit bids.
// Each medium tick:
//
//   1. matchRentalAuction(offers, bids) clears the order book per pair —
//      highest bid above the offer's floor wins, settles at the owner's
//      floor (renter pays floor, not their max).
//   2. settleRentals(activeRentals, ...) advances all live rentals one
//      tick: leg P&L flows into the renter's `rentalMargin`; the owner
//      receives the tip rate from the renter's margin; defaults and
//      expirations terminate the rental cleanly.
//
// All functions are pure — they take state in, return new state out.
// No side effects; no I/O.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Default minimum tip rate floor for owner-published offers (per-epoch
// fraction of leg notional). Owners can override.
export const DEFAULT_MIN_TIP_RATE = 0.005;

// Renter posts this fraction of leg notional as collateral. Absorbs
// adverse leg P&L first; if exhausted, the rental defaults.
export const RENTAL_MARGIN_FRACTION = 0.20;

// Offer TTL: drop unmatched offers after this many medium epochs so the
// orderbook doesn't accumulate stale entries.
export const OFFER_TTL_EPOCHS = 3;

// Same idea for bids — drop after this many ticks if not matched.
export const BID_TTL_EPOCHS = 2;

// ---------------------------------------------------------------------------
// ID helpers
// ---------------------------------------------------------------------------

let _ctr = 0;
const _uid = (prefix) => `${prefix}-${Date.now().toString(36)}-${(++_ctr).toString(36)}`;

export function makeOfferId() { return _uid("RENT-OFFER"); }
export function makeBidId()   { return _uid("RENT-BID"); }
export function makeRentalId(){ return _uid("RENT"); }

// ---------------------------------------------------------------------------
// Publish / place
// ---------------------------------------------------------------------------

// Owner-side: publish an offer to lease one leg of a paired LAP.
export function publishLegOffer({
  pairLapId,
  legSide,                // "long" | "short"
  ownerId,
  pairKey,
  minTipRate = DEFAULT_MIN_TIP_RATE,
  durationEpochs = 5,
  publishedAtEpoch = 0,
}) {
  return {
    id: makeOfferId(),
    pairLapId,
    legSide,
    ownerId,
    pairKey,
    minTipRate,
    durationEpochs,
    publishedAtEpoch,
    expiresAtEpoch: publishedAtEpoch + OFFER_TTL_EPOCHS,
    active: true,
  };
}

// Renter-side: place a bid for ANY available leg on `pairKey`.
// Bidder must have already escrowed `rentalMargin` somewhere; this
// module just records the bid.
export function placeRentalBid({
  bidderId,
  pairKey,
  maxTipRate,
  durationEpochs = 5,
  rentalMargin,
  publishedAtEpoch = 0,
}) {
  return {
    id: makeBidId(),
    bidderId,
    pairKey,
    maxTipRate,
    durationEpochs,
    rentalMargin,
    publishedAtEpoch,
    expiresAtEpoch: publishedAtEpoch + BID_TTL_EPOCHS,
    active: true,
  };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Per-pair clearing. For each pair, sort offers ascending by floor and
// bids descending by max tip; greedily pair them. A match clears at
// the owner's floor (renter gets a discount vs their max bid).
//
// Returns:
//   { newRentals, remainingOffers, remainingBids, expiredOffers, expiredBids, logs }
//
// `newRentals` are matched-and-active records to be appended to
// `pairState.activeRentals`. The matched offers / bids are dropped
// from the orderbook lists.
//
// Currently no fractional fills; one match per offer per call.
export function matchRentalAuction({
  offers = [],
  bids = [],
  currentEpoch = 0,
}) {
  const logs = [];

  // Drop expired entries up-front so they aren't matched.
  const liveOffers = offers.filter(
    (o) => o.active && currentEpoch < o.expiresAtEpoch
  );
  const liveBids = bids.filter(
    (b) => b.active && currentEpoch < b.expiresAtEpoch
  );
  const expiredOffers = offers.filter(
    (o) => !(o.active && currentEpoch < o.expiresAtEpoch)
  );
  const expiredBids = bids.filter(
    (b) => !(b.active && currentEpoch < b.expiresAtEpoch)
  );

  // Group by pair.
  const byPair = {};
  for (const o of liveOffers) {
    (byPair[o.pairKey] ??= { offers: [], bids: [] }).offers.push(o);
  }
  for (const b of liveBids) {
    (byPair[b.pairKey] ??= { offers: [], bids: [] }).bids.push(b);
  }

  const newRentals = [];
  const matchedOfferIds = new Set();
  const matchedBidIds = new Set();

  for (const pairKey of Object.keys(byPair)) {
    const { offers: po, bids: pb } = byPair[pairKey];
    // Lowest floor first; highest bid first.
    po.sort((a, b) => a.minTipRate - b.minTipRate);
    pb.sort((a, b) => b.maxTipRate - a.maxTipRate);

    let bi = 0;
    for (const offer of po) {
      // Find the highest bid willing to pay at least the floor. Skip
      // any already matched.
      while (bi < pb.length && matchedBidIds.has(pb[bi].id)) bi += 1;
      if (bi >= pb.length) break;
      const bid = pb[bi];
      if (bid.maxTipRate < offer.minTipRate) {
        // Best remaining bid can't even meet this offer's floor — and
        // since bids are sorted descending, no later bid will either.
        break;
      }
      // Clear at the owner's floor (renter gets the discount).
      const tipRate = offer.minTipRate;
      const duration = Math.min(offer.durationEpochs, bid.durationEpochs);
      const rental = {
        id: makeRentalId(),
        pairLapId: offer.pairLapId,
        legSide: offer.legSide,
        ownerId: offer.ownerId,
        renterId: bid.bidderId,
        pairKey,
        tipRate,
        durationEpochs: duration,
        rentalMargin: bid.rentalMargin,
        accruedOwnerTips: 0,
        matchedAtEpoch: currentEpoch,
        expiresAtEpoch: currentEpoch + duration,
        active: true,
      };
      newRentals.push(rental);
      matchedOfferIds.add(offer.id);
      matchedBidIds.add(bid.id);
      bi += 1;
      logs.push(
        `[RENT-MATCH] ${pairKey} ${offer.legSide} ${offer.ownerId}→${bid.bidderId} @ ${(tipRate * 100).toFixed(2)}%/ep for ${duration}ep`
      );
    }
  }

  const remainingOffers = liveOffers.filter((o) => !matchedOfferIds.has(o.id));
  const remainingBids = liveBids.filter((b) => !matchedBidIds.has(b.id));

  return {
    newRentals,
    remainingOffers,
    remainingBids,
    expiredOffers,
    expiredBids,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

// Settle one tick of all active rentals on a single pair.
//
// For each active rental:
//   - Compute leg P&L = legMargin × leverage × (exp(direction × logRet) − 1)
//   - rentalMargin += legPnl  (renter takes leg P&L)
//   - tipFee = tipRate × legNotional         (renter pays per-epoch fee)
//   - rentalMargin -= tipFee                  (fee comes out of renter)
//   - accruedOwnerTips += tipFee              (owner accrues — flushed on close)
//   - If rentalMargin <= 0:    DEFAULT — terminate, owner keeps accrued tips,
//                              leg reverts unrented, renter loses posted margin.
//   - Else if currentEpoch >= expiresAtEpoch: EXPIRE — terminate cleanly,
//                              renter recovers (rentalMargin) + tip stream
//                              already paid.
//
// Inputs:
//   activeRentals — rentals currently live on this pair
//   findPairedLap(id) — accessor into the position table (returns
//                      { margin, leverage, openPrice } for the LAP)
//   priceOld, priceNew — pair prices for this epoch's leg P&L
//   currentEpoch
//
// Returns:
//   { rentals, terminated, ownerCredits, defaultedRenters, logs }
//   - rentals: still-active rentals (terminated ones removed)
//   - terminated: { rental, reason: "expired" | "default", finalRenterMargin }
//   - ownerCredits: { [ownerId]: totalTipsThisTick } — caller flushes to margin
//   - defaultedRenters: [renterId, ...] — caller may want to log
export function settleRentals({
  activeRentals = [],
  findPairedLap,
  priceOld,
  priceNew,
  currentEpoch,
}) {
  const stillActive = [];
  const terminated = [];
  const ownerCredits = {};
  const defaultedRenters = [];
  const logs = [];

  if (!activeRentals.length || !Number.isFinite(priceOld) || !Number.isFinite(priceNew)) {
    return {
      rentals: activeRentals,
      terminated,
      ownerCredits,
      defaultedRenters,
      logs,
    };
  }
  if (priceOld <= 0 || priceNew <= 0) {
    return {
      rentals: activeRentals,
      terminated,
      ownerCredits,
      defaultedRenters,
      logs,
    };
  }

  const logRet = Math.log(priceNew / priceOld);

  for (const r of activeRentals) {
    if (!r.active) {
      stillActive.push(r);
      continue;
    }
    const lap = typeof findPairedLap === "function" ? findPairedLap(r.pairLapId) : null;
    if (!lap) {
      // Underlying position vanished (e.g. owner closed the paired LAP).
      // Terminate gracefully; owner keeps accrued tips.
      terminated.push({ rental: r, reason: "lap-gone", finalRenterMargin: r.rentalMargin });
      logs.push(`[RENT-TERM] ${r.id} terminated — underlying paired LAP missing`);
      continue;
    }

    const legMargin = (lap.margin ?? 0) / 2;
    const lev = lap.leverage ?? 1;
    const direction = r.legSide === "long" ? 1 : -1;
    const legPnl = legMargin * lev * (Math.exp(direction * logRet) - 1);
    const legNotional = legMargin * lev;
    const tipFee = r.tipRate * legNotional;

    // Apply leg P&L first (renter takes it), then deduct the tip fee.
    let newRenterMargin = r.rentalMargin + legPnl - tipFee;
    let accruedOwnerTips = (r.accruedOwnerTips ?? 0) + tipFee;

    if (newRenterMargin <= 0) {
      // Default. Renter's last bit of margin contributes whatever's
      // recoverable; the protocol absorbs any shortfall.
      const recovered = Math.max(0, newRenterMargin); // 0 in practice
      ownerCredits[r.ownerId] = (ownerCredits[r.ownerId] ?? 0) + accruedOwnerTips;
      terminated.push({
        rental: { ...r, rentalMargin: 0, accruedOwnerTips, active: false },
        reason: "default",
        finalRenterMargin: recovered,
      });
      defaultedRenters.push(r.renterId);
      logs.push(
        `[RENT-DEFAULT] ${r.id} ${r.renterId} blew through margin — leg reverts to owner ${r.ownerId}`
      );
      continue;
    }

    if (currentEpoch >= r.expiresAtEpoch) {
      // Clean expiry. Owner keeps accrued tips; renter recovers their
      // remaining rentalMargin (caller handles the refund).
      ownerCredits[r.ownerId] = (ownerCredits[r.ownerId] ?? 0) + accruedOwnerTips;
      terminated.push({
        rental: {
          ...r,
          rentalMargin: newRenterMargin,
          accruedOwnerTips,
          active: false,
        },
        reason: "expired",
        finalRenterMargin: newRenterMargin,
      });
      logs.push(
        `[RENT-EXPIRE] ${r.id} ${r.legSide} cleanly returned to ${r.ownerId}`
      );
      continue;
    }

    stillActive.push({
      ...r,
      rentalMargin: newRenterMargin,
      accruedOwnerTips,
    });
  }

  // For Phase 3, owner tips are flushed each tick (caller transfers them
  // out of the rental and into the owner's main margin). Reset accrual
  // on each remaining-active rental so we don't double-count next tick.
  const flushedActive = stillActive.map((r) => {
    const credit = r.accruedOwnerTips ?? 0;
    if (credit > 0) {
      ownerCredits[r.ownerId] = (ownerCredits[r.ownerId] ?? 0) + credit;
    }
    return { ...r, accruedOwnerTips: 0 };
  });

  return {
    rentals: flushedActive,
    terminated,
    ownerCredits,
    defaultedRenters,
    logs,
  };
}

// Manual termination path (e.g. owner closes the paired LAP). Marks
// the rental as inactive and returns the refund owed to the renter
// (their remaining rentalMargin). Caller flushes ownerCredits.
export function terminateRental(rental) {
  if (!rental || !rental.active) return null;
  return {
    rental: { ...rental, active: false },
    refundToRenter: Math.max(0, rental.rentalMargin ?? 0),
    finalOwnerCredit: rental.accruedOwnerTips ?? 0,
  };
}
