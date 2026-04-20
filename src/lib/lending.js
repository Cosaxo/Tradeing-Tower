// Position lending market.
//
// Lenders post offers (amount + rental rate + duration). Borrowers match
// against the cheapest offer that covers their desired size. Rental income
// is settled each medium epoch.

let offerIdCounter = 0;
let borrowIdCounter = 0;

export function createOffer(lenderId, amount, rate, duration) {
  return {
    id: `OFFER-${++offerIdCounter}`,
    lenderId,
    amount,
    remaining: amount,
    rate,
    duration,
    active: true,
    createdEpoch: null,
  };
}

// Match a borrower request against the cheapest available offers.
// Returns { borrows, updatedOffers, unfilled }.
export function matchBorrowRequest(offers, borrowerId, desiredAmount, maxRate) {
  const candidates = offers
    .filter((o) => o.active && o.remaining > 0 && o.rate <= maxRate)
    .sort((a, b) => a.rate - b.rate);

  const borrows = [];
  const updatedOffers = offers.map((o) => ({ ...o }));
  let needed = desiredAmount;

  for (const cand of candidates) {
    if (needed <= 0) break;
    const take = Math.min(needed, cand.remaining);
    const target = updatedOffers.find((o) => o.id === cand.id);
    target.remaining -= take;
    if (target.remaining <= 0.001) target.active = false;

    borrows.push({
      id: `BORROW-${++borrowIdCounter}`,
      borrowerId,
      lenderId: cand.lenderId,
      offerId: cand.id,
      amount: take,
      rate: cand.rate,
      remaining: cand.duration,
      active: true,
    });
    needed -= take;
  }

  return { borrows, updatedOffers, unfilled: Math.max(0, needed) };
}

// Settle one medium epoch of rental income across active borrows.
export function settleLending(borrows, offers) {
  const logs = [];
  const payouts = {}; // { lenderId: totalRent }
  let totalRent = 0;

  const updatedBorrows = borrows.map((b) => {
    if (!b.active || b.remaining <= 0) return { ...b, active: false };
    const rent = b.amount * b.rate;
    payouts[b.lenderId] = (payouts[b.lenderId] ?? 0) + rent;
    totalRent += rent;
    const newRemaining = b.remaining - 1;
    if (newRemaining <= 0) {
      logs.push(
        `[LEND] ${b.borrowerId} closed borrow from ${b.lenderId} — returned $${b.amount}`
      );
    }
    return { ...b, remaining: newRemaining, active: newRemaining > 0, lastRent: rent };
  });

  if (totalRent > 0) {
    logs.push(
      `[LEND] ${updatedBorrows.filter((b) => b.active).length} active borrows paid $${totalRent.toFixed(2)} rent`
    );
  }

  return { borrows: updatedBorrows, offers, payouts, totalRent, logs };
}

// Close an offer (lender withdraws unborrowed portion).
export function cancelOffer(offers, offerId) {
  return offers.map((o) => (o.id === offerId ? { ...o, active: false } : o));
}
