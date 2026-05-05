// Spend commitment — Tier 5 of the Hyperfloat thread protocol.
//
// What it does
// ------------
// Captures the float that legacy financial systems drain through gift
// cards, prepaid cards, loyalty programs, and Costco-style memberships.
// Sellers compete for committed wallet-share by paying CASH UPFRONT
// (not by offering discounts) — same customer-acquisition spend they'd
// otherwise pay marketing platforms, redirected to the customer.
//
// Mechanism (per the v0.6 whitepaper §1.5)
// ----------------------------------------
// 1. User commits a budget for a category (e.g. $200/month groceries
//    for 6 months → $1,200 total).
// 2. Eligible sellers post bids — each bid is a CASH AMOUNT the seller
//    is willing to pay to win the commitment.
// 3. User accepts the highest bid. Smart contract atomically:
//      - Transfers bidAmount from seller to user (immediate).
//      - Locks the user's totalCommitment of FLOAT for spending only at
//        this seller, only on this category, only within the window.
// 4. The locked FLOAT keeps earning yield via the underlying thread
//    (layers 1-3 all continue paying their normal rates on the
//    unspent locked balance).
// 5. User shops normally — no per-purchase discount logic. Spends
//    deduct from the locked amount.
// 6. End-of-window: fully spent → clean close. Underspent → small
//    penalty on the unspent fraction transfers to the seller; rest
//    returns to free balance.
//
// Conservation
// ------------
// Every flow has a named counterparty pair, so the books balance
// across (user, seller) pairs. The protocol itself takes no spread
// (in v1; a small fee may be added later as a protocol-revenue source).
//
// Pure functions
// --------------
// All exports are pure functions of inputs returning new state. Caller
// (App.jsx / useEpochLoop) is responsible for actually transferring
// FLOAT balances based on the returned `transfers` arrays.

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// One "period" = this many medium ticks. With a medium tick of ~6s
// and a sim-day mapping, one period ≈ a sim-month.
export const PERIOD_LENGTH_EPOCHS = 30;

// Penalty rate applied to the UNSPENT portion at expiration. Goes to
// the seller as compensation for the broken commitment. 5% by
// default — calibrated against real customer-acquisition costs:
// the seller's bid payment was ~5-10% of commitment, so a 5%
// penalty roughly matches the seller's loss-per-unit-unfulfilled-spend.
export const DEFAULT_PENALTY_RATE = 0.05;

// Status enum-like.
export const STATUS_OPEN_AUCTION = "OPEN_AUCTION";
export const STATUS_ACTIVE_LOCK = "ACTIVE_LOCK";
export const STATUS_COMPLETED = "COMPLETED";
export const STATUS_EXPIRED = "EXPIRED";
export const STATUS_CANCELLED = "CANCELLED";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _commitCtr = 0;
const _commitId = () =>
  `COMMIT-${Date.now().toString(36)}-${(++_commitCtr).toString(36)}`;
let _bidCtr = 0;
const _bidId = () =>
  `BID-${Date.now().toString(36)}-${(++_bidCtr).toString(36)}`;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initSpendCommitmentState() {
  return {
    commitments: [],
    cumulativeBidsReceived: 0,
    cumulativeSpent: 0,
    cumulativePenalties: 0,
  };
}

// ---------------------------------------------------------------------------
// Open an auction (user side)
// ---------------------------------------------------------------------------

// Create a new commitment in OPEN_AUCTION state. Sellers can post bids
// until the user accepts one (transitioning it to ACTIVE_LOCK) or the
// user cancels.
//
// Inputs:
//   userId, category (string), budgetPerPeriod ($), numPeriods, currentEpoch
//
// Returns: { ok, state, commitment, reason? }
export function createCommitment({
  state,
  userId,
  category,
  budgetPerPeriod,
  numPeriods,
  currentEpoch = 0,
}) {
  if (!userId) return { ok: false, reason: "missing userId" };
  if (typeof category !== "string" || category.length === 0) {
    return { ok: false, reason: "category required" };
  }
  if (!Number.isFinite(budgetPerPeriod) || budgetPerPeriod <= 0) {
    return { ok: false, reason: "budgetPerPeriod must be positive" };
  }
  if (!Number.isInteger(numPeriods) || numPeriods <= 0) {
    return { ok: false, reason: "numPeriods must be a positive integer" };
  }

  const totalCommitment = budgetPerPeriod * numPeriods;

  const commitment = {
    id: _commitId(),
    userId,
    category,
    budgetPerPeriod,
    numPeriods,
    totalCommitment,
    status: STATUS_OPEN_AUCTION,
    bids: [],
    acceptedBidId: null,
    acceptedSeller: null,
    acceptedBidAmount: 0,
    lockedAmount: 0,
    spentAmount: 0,
    spendingEvents: [],
    createdAtEpoch: currentEpoch,
    acceptedAtEpoch: null,
    expiresAtEpoch: null,
  };

  return {
    ok: true,
    state: {
      ...state,
      commitments: [...state.commitments, commitment],
    },
    commitment,
  };
}

// ---------------------------------------------------------------------------
// Post a bid (seller side)
// ---------------------------------------------------------------------------

// A seller posts a CASH bid on an open commitment. The bid amount is
// what they're willing to pay the user upfront for winning the
// commitment.
//
// Returns: { ok, state, bid, reason? }
export function postBid({ state, commitmentId, sellerId, bidAmount, terms }) {
  if (!sellerId) return { ok: false, reason: "missing sellerId" };
  if (!Number.isFinite(bidAmount) || bidAmount <= 0) {
    return { ok: false, reason: "bidAmount must be positive" };
  }

  const idx = state.commitments.findIndex((c) => c.id === commitmentId);
  if (idx < 0) return { ok: false, reason: "commitment not found" };
  const c = state.commitments[idx];
  if (c.status !== STATUS_OPEN_AUCTION) {
    return { ok: false, reason: `auction not open (${c.status})` };
  }
  if (c.userId === sellerId) {
    return { ok: false, reason: "user cannot bid on their own commitment" };
  }

  const bid = {
    id: _bidId(),
    sellerId,
    bidAmount,
    terms: terms ?? null,
    postedAtEpoch: c.createdAtEpoch,
  };

  const updatedCommitment = { ...c, bids: [...c.bids, bid] };
  const newCommitments = [...state.commitments];
  newCommitments[idx] = updatedCommitment;

  return {
    ok: true,
    state: { ...state, commitments: newCommitments },
    bid,
  };
}

// ---------------------------------------------------------------------------
// Accept a bid (user side)
// ---------------------------------------------------------------------------

// User accepts a specific bid (or, if bidId is null, the highest bid).
// Atomically: transitions the commitment to ACTIVE_LOCK, records the
// accepted bid, sets the expiration epoch.
//
// Critically: this returns a `transfers` array describing the cash flow
// that the caller must execute on the actual FLOAT state:
//   - bidAmount from seller → user (immediate cash payment for the win)
//   - lockedAmount of user's FLOAT → escrow (spendable only at seller)
//
// Returns: { ok, state, commitment, transfers, reason? }
export function acceptBid({
  state,
  commitmentId,
  bidId = null,
  currentEpoch = 0,
}) {
  const idx = state.commitments.findIndex((c) => c.id === commitmentId);
  if (idx < 0) return { ok: false, reason: "commitment not found" };
  const c = state.commitments[idx];
  if (c.status !== STATUS_OPEN_AUCTION) {
    return { ok: false, reason: `auction not open (${c.status})` };
  }
  if (c.bids.length === 0) {
    return { ok: false, reason: "no bids to accept" };
  }

  // If bidId not specified, pick the highest. Tie-break by earliest
  // posting (deterministic).
  let acceptedBid;
  if (bidId) {
    acceptedBid = c.bids.find((b) => b.id === bidId);
    if (!acceptedBid) return { ok: false, reason: "bid not found" };
  } else {
    acceptedBid = c.bids.reduce((best, b) =>
      b.bidAmount > best.bidAmount ? b : best
    , c.bids[0]);
  }

  const expiresAtEpoch =
    currentEpoch + c.numPeriods * PERIOD_LENGTH_EPOCHS;

  const updatedCommitment = {
    ...c,
    status: STATUS_ACTIVE_LOCK,
    acceptedBidId: acceptedBid.id,
    acceptedSeller: acceptedBid.sellerId,
    acceptedBidAmount: acceptedBid.bidAmount,
    lockedAmount: c.totalCommitment,
    spentAmount: 0,
    acceptedAtEpoch: currentEpoch,
    expiresAtEpoch,
    bids: c.bids, // preserved for audit
  };

  const newCommitments = [...state.commitments];
  newCommitments[idx] = updatedCommitment;

  return {
    ok: true,
    state: {
      ...state,
      commitments: newCommitments,
      cumulativeBidsReceived:
        state.cumulativeBidsReceived + acceptedBid.bidAmount,
    },
    commitment: updatedCommitment,
    transfers: [
      // Seller pays user the bid amount.
      {
        type: "BID_PAYMENT",
        from: acceptedBid.sellerId,
        to: c.userId,
        amount: acceptedBid.bidAmount,
      },
      // User's FLOAT face is locked into escrow (the smart contract
      // designation; no actual transfer happens — the FLOAT stays in
      // the user's wallet but is restricted-spend).
      {
        type: "LOCK",
        from: c.userId,
        to: `ESCROW:${commitmentId}`,
        amount: c.totalCommitment,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Spend at the accepted seller (user side, ongoing)
// ---------------------------------------------------------------------------

// Record a spend event during the lock period. Each spend deducts from
// the locked amount and triggers a FLOAT transfer from user to seller.
//
// Returns: { ok, state, commitment, transfers, reason? }
export function spendAtSeller({
  state,
  commitmentId,
  sellerId,
  amount,
  currentEpoch = 0,
}) {
  const idx = state.commitments.findIndex((c) => c.id === commitmentId);
  if (idx < 0) return { ok: false, reason: "commitment not found" };
  const c = state.commitments[idx];
  if (c.status !== STATUS_ACTIVE_LOCK) {
    return { ok: false, reason: `commitment not active (${c.status})` };
  }
  if (sellerId !== c.acceptedSeller) {
    return {
      ok: false,
      reason: `seller mismatch (commitment is locked to ${c.acceptedSeller})`,
    };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  const remaining = c.lockedAmount - c.spentAmount;
  if (amount > remaining + 1e-9) {
    return {
      ok: false,
      reason: `amount exceeds remaining balance ($${remaining.toFixed(2)})`,
    };
  }

  const newSpentAmount = c.spentAmount + amount;
  const fullySpent = newSpentAmount >= c.lockedAmount - 1e-9;

  const updatedCommitment = {
    ...c,
    spentAmount: newSpentAmount,
    spendingEvents: [
      ...c.spendingEvents,
      { epoch: currentEpoch, amount },
    ],
    status: fullySpent ? STATUS_COMPLETED : STATUS_ACTIVE_LOCK,
  };

  const newCommitments = [...state.commitments];
  newCommitments[idx] = updatedCommitment;

  return {
    ok: true,
    state: {
      ...state,
      commitments: newCommitments,
      cumulativeSpent: state.cumulativeSpent + amount,
    },
    commitment: updatedCommitment,
    transfers: [
      // Spend from escrow → seller.
      {
        type: "SPEND",
        from: `ESCROW:${commitmentId}`,
        to: sellerId,
        amount,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Cancel an open auction (user side)
// ---------------------------------------------------------------------------

// Only allowed in OPEN_AUCTION phase. Once a bid is accepted (status
// → ACTIVE_LOCK), the user cannot cancel — they can only let it expire
// (paying the penalty on unspent).
export function cancelCommitment({ state, commitmentId, userId }) {
  const idx = state.commitments.findIndex((c) => c.id === commitmentId);
  if (idx < 0) return { ok: false, reason: "commitment not found" };
  const c = state.commitments[idx];
  if (c.userId !== userId) return { ok: false, reason: "not the owner" };
  if (c.status !== STATUS_OPEN_AUCTION) {
    return {
      ok: false,
      reason: `cannot cancel — status is ${c.status}`,
    };
  }
  const updatedCommitment = { ...c, status: STATUS_CANCELLED };
  const newCommitments = [...state.commitments];
  newCommitments[idx] = updatedCommitment;
  return {
    ok: true,
    state: { ...state, commitments: newCommitments },
    commitment: updatedCommitment,
  };
}

// ---------------------------------------------------------------------------
// Process tick — handle expirations
// ---------------------------------------------------------------------------

// Per medium tick (or whatever cadence the loop chooses), expire any
// ACTIVE_LOCK commitments whose expiresAtEpoch has passed. For each:
//   - unspent = locked - spent
//   - penalty = unspent × penaltyRate (transferred to seller)
//   - refund = unspent - penalty (transferred back to user)
//
// Returns: { state, expirations, transfers }
//   expirations: [{ commitmentId, userId, sellerId, unspent, penalty, refund }]
//   transfers: [...] (caller materialises on FLOAT state)
export function processCommitmentTick({
  state,
  currentEpoch,
  penaltyRate = DEFAULT_PENALTY_RATE,
}) {
  const expirations = [];
  const transfers = [];
  let cumulativePenalties = state.cumulativePenalties;

  const newCommitments = state.commitments.map((c) => {
    if (c.status !== STATUS_ACTIVE_LOCK) return c;
    if (c.expiresAtEpoch == null || currentEpoch < c.expiresAtEpoch) return c;

    // Expire.
    const unspent = Math.max(0, c.lockedAmount - c.spentAmount);
    const penalty = unspent * penaltyRate;
    const refund = unspent - penalty;

    expirations.push({
      commitmentId: c.id,
      userId: c.userId,
      sellerId: c.acceptedSeller,
      unspent,
      penalty,
      refund,
    });

    if (penalty > 1e-9) {
      transfers.push({
        type: "EXPIRY_PENALTY",
        from: `ESCROW:${c.id}`,
        to: c.acceptedSeller,
        amount: penalty,
      });
      cumulativePenalties += penalty;
    }
    if (refund > 1e-9) {
      transfers.push({
        type: "EXPIRY_REFUND",
        from: `ESCROW:${c.id}`,
        to: c.userId,
        amount: refund,
      });
    }

    return { ...c, status: STATUS_EXPIRED };
  });

  return {
    state: {
      ...state,
      commitments: newCommitments,
      cumulativePenalties,
    },
    expirations,
    transfers,
  };
}

// ---------------------------------------------------------------------------
// Accessors
// ---------------------------------------------------------------------------

export function getCommitmentById(state, id) {
  return state.commitments.find((c) => c.id === id) ?? null;
}

export function getOpenAuctions(state, category = null) {
  return state.commitments.filter(
    (c) =>
      c.status === STATUS_OPEN_AUCTION &&
      (category == null || c.category === category)
  );
}

export function getActiveCommitments(state, userId) {
  return state.commitments.filter(
    (c) => c.userId === userId && c.status === STATUS_ACTIVE_LOCK
  );
}

export function getUserCommitments(state, userId) {
  return state.commitments.filter((c) => c.userId === userId);
}

export function totalLockedForUser(state, userId) {
  return getActiveCommitments(state, userId).reduce(
    (sum, c) => sum + Math.max(0, c.lockedAmount - c.spentAmount),
    0
  );
}

// Compute the user's "average expected float yield" on a commitment.
// Useful for UI projections. Assumes linear spending (spends evenly
// across the period). Returns dollar amount of expected yield over
// the full window.
export function projectFloatYield({ commitment, annualYieldRate = 0.085 }) {
  const totalDays = commitment.numPeriods * PERIOD_LENGTH_EPOCHS;
  // Average locked balance over the window assuming linear spending:
  // starts at locked, ends at 0, average = locked / 2.
  const avgLockedBalance = commitment.totalCommitment / 2;
  return avgLockedBalance * annualYieldRate * (totalDays / 365);
}
