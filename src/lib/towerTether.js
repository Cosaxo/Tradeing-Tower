// Tower Tether (TT) — fully-collateralized stablecoin minted against
// pool deposits.
//
// TT is intended to be used OUTSIDE the protocol — accepted at merchants
// the way credit cards are today. It has no in-protocol utility (no fee
// acceptance, no leverage-cap lift, no power-up sinks). The only things
// you do with TT inside the simulator:
//
//   1. Mint  — depositors with sufficient LTV lock collateral, receive TT
//   2. Hold  — TT sits in the user's wallet
//   3. Spend — transfer TT to a merchant (simulating real-world purchase)
//   4. Redeem — TT holder converts TT back to dollars; the minters whose
//               collateral backed those units lose pro-rata share
//
// Redemption is rate-limited: only `STANDARD_REDEMPTION_CAP_PCT` of
// total supply can clear in a normal cycle, FIFO, no fee. Holders who
// need to exit faster than that can submit an Express request and pay
// `EXPRESS_PENALTY_RATE` of the redeemed amount (penalty flows to the
// insurance pool — depositors win when others panic). Cycles run on a
// long, prime-coprime cadence (REDEMPTION_EVERY medium ticks, ~monthly
// in sim-time) so the queue creates real liquidity pressure.
//
// "Burning" is a misnomer here. Redemption converts TT back to dollars
// pulled from minters' collateral; the affected minters lose a share
// of their pool deposit (and their outstanding-mint claim shrinks
// accordingly). TT supply DOES decrease as redemptions clear, but
// nothing is destroyed — it's a real-world exchange of TT-for-dollars.

import {
  MINT_COEFFICIENT,
  MINT_LTV_GATE,
  STANDARD_REDEMPTION_CAP_PCT,
  EXPRESS_PENALTY_RATE,
} from "../constants/system.js";

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initTtState() {
  return {
    // Outstanding mints per user. sum(mintedByUser) === totalSupply
    // (modulo float precision). When a redemption clears, every minter
    // loses pro-rata.
    mintedByUser: {},
    // Wallet balances. sum(balances) + merchantBalance ===
    // totalSupply (TT can be transferred but not destroyed except via
    // redemption).
    balances: {},
    // Solvency claw-back debt. If a minter's collateral drops below
    // their outstanding mint (e.g. pool claim haircut), the protocol
    // tries to claw from their wallet first; any shortfall becomes
    // debt that blocks future mints until repaid.
    debtByUser: {},
    // FIFO queue of pending redemption requests.
    redemptionQueue: [],
    // Merchant pool — TT spent at simulated stores. The merchant
    // periodically redeems from here, creating organic queue pressure.
    merchantBalance: 0,
    // Bookkeeping.
    lastRedemptionEpoch: -1,
    cumulativePenaltyToPool: 0,
  };
}

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

export function totalSupply(ttState) {
  return Object.values(ttState?.mintedByUser ?? {}).reduce((s, v) => s + v, 0);
}

export function totalCirculating(ttState) {
  const balances = Object.values(ttState?.balances ?? {}).reduce((s, v) => s + v, 0);
  return balances + (ttState?.merchantBalance ?? 0);
}

export function balanceOf(ttState, userId) {
  return ttState?.balances?.[userId] ?? 0;
}

export function mintedByOf(ttState, userId) {
  return ttState?.mintedByUser?.[userId] ?? 0;
}

export function debtOf(ttState, userId) {
  return ttState?.debtByUser?.[userId] ?? 0;
}

// Maximum a user can mint right now given their deposit + LTV.
// Subtracts already-outstanding mint and any clawback debt.
export function mintCapacity({ ttState, userId, deposit, ltv }) {
  if (!Number.isFinite(deposit) || deposit <= 0) return 0;
  if (!Number.isFinite(ltv) || ltv <= 0) return 0;
  if (ltv < MINT_LTV_GATE) return 0;
  const cap = deposit * ltv * MINT_COEFFICIENT;
  const outstanding = mintedByOf(ttState, userId) + debtOf(ttState, userId);
  return Math.max(0, cap - outstanding);
}

// ---------------------------------------------------------------------------
// Mint
// ---------------------------------------------------------------------------

// Returns { ok: true, ttState } on success, { ok: false, reason } otherwise.
// Mints into the user's own wallet by default.
export function mintTT({ ttState, userId, amount, deposit, ltv }) {
  if (!userId) return { ok: false, reason: "no userId" };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  if (ltv < MINT_LTV_GATE) {
    return { ok: false, reason: `LTV ${ltv.toFixed(2)} below gate ${MINT_LTV_GATE.toFixed(2)}` };
  }
  const capacity = mintCapacity({ ttState, userId, deposit, ltv });
  if (amount > capacity + 1e-6) {
    return { ok: false, reason: `over capacity (max ${capacity.toFixed(2)})` };
  }
  return {
    ok: true,
    ttState: {
      ...ttState,
      mintedByUser: {
        ...ttState.mintedByUser,
        [userId]: (ttState.mintedByUser[userId] ?? 0) + amount,
      },
      balances: {
        ...ttState.balances,
        [userId]: (ttState.balances[userId] ?? 0) + amount,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Transfer / spend
// ---------------------------------------------------------------------------

// Wallet-to-wallet transfer. `toId` may be the literal string "MERCHANT"
// to send to the simulated merchant pool (used for the "spend in store"
// abstraction in the sim).
export function transferTT({ ttState, fromId, toId, amount }) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  const fromBal = ttState.balances?.[fromId] ?? 0;
  if (fromBal < amount - 1e-6) {
    return { ok: false, reason: "insufficient TT balance" };
  }
  const next = {
    ...ttState,
    balances: {
      ...ttState.balances,
      [fromId]: fromBal - amount,
    },
  };
  if (toId === "MERCHANT") {
    next.merchantBalance = (ttState.merchantBalance ?? 0) + amount;
  } else {
    next.balances[toId] = (ttState.balances?.[toId] ?? 0) + amount;
  }
  return { ok: true, ttState: next };
}

// ---------------------------------------------------------------------------
// Redemption queue
// ---------------------------------------------------------------------------

let _reqCtr = 0;
const _reqId = () => `RED-${Date.now().toString(36)}-${(++_reqCtr).toString(36)}`;

// Submit a redemption request. The user's TT is moved into a "pending
// redemption" escrow inside the queue entry — until the request clears
// or is cancelled, that TT is locked.
export function submitRedemption({
  ttState,
  userId,
  amount,
  express = false,
  currentEpoch = 0,
}) {
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  // Allow MERCHANT to redeem too (used by the merchant simulator).
  const fromBalance = userId === "MERCHANT"
    ? (ttState.merchantBalance ?? 0)
    : (ttState.balances?.[userId] ?? 0);
  if (fromBalance < amount - 1e-6) {
    return { ok: false, reason: "insufficient TT balance" };
  }
  const next = { ...ttState };
  if (userId === "MERCHANT") {
    next.merchantBalance = fromBalance - amount;
  } else {
    next.balances = { ...ttState.balances, [userId]: fromBalance - amount };
  }
  const entry = {
    id: _reqId(),
    userId,
    amount,
    express,
    penaltyRate: express ? EXPRESS_PENALTY_RATE : 0,
    submittedAtEpoch: currentEpoch,
  };
  next.redemptionQueue = [...(ttState.redemptionQueue ?? []), entry];
  return { ok: true, ttState: next, requestId: entry.id };
}

// Cancel a pending request — TT returns to the user's wallet.
export function cancelRedemption({ ttState, requestId }) {
  const queue = ttState.redemptionQueue ?? [];
  const idx = queue.findIndex((r) => r.id === requestId);
  if (idx < 0) return { ok: false, reason: "request not found" };
  const entry = queue[idx];
  const next = { ...ttState, redemptionQueue: queue.filter((_, i) => i !== idx) };
  if (entry.userId === "MERCHANT") {
    next.merchantBalance = (ttState.merchantBalance ?? 0) + entry.amount;
  } else {
    next.balances = {
      ...ttState.balances,
      [entry.userId]: (ttState.balances?.[entry.userId] ?? 0) + entry.amount,
    };
  }
  return { ok: true, ttState: next };
}

// Drain one cycle's worth of the redemption queue.
//
// Process order:
//   1. FIFO scan — drain Express requests immediately (no cap, penalty applied).
//   2. FIFO scan — drain Standard requests up to STANDARD_REDEMPTION_CAP_PCT
//      of the supply at cycle start.
//
// For each cleared request, compute pro-rata haircut allocation across
// current minters (BEFORE the request's own minter share, since their
// stake is also part of the backing).
//
// Returns:
//   { ttState,
//     dollarsOut: { [userId]: total $$ paid out },
//     collateralHaircuts: { [minterId]: total $ to remove from deposit },
//     penaltyToPool: number,
//     logs: string[] }
export function runRedemptionCycle({ ttState, currentEpoch }) {
  const logs = [];
  const queue = [...(ttState.redemptionQueue ?? [])];
  if (queue.length === 0) {
    return {
      ttState: { ...ttState, lastRedemptionEpoch: currentEpoch },
      dollarsOut: {},
      collateralHaircuts: {},
      penaltyToPool: 0,
      logs,
    };
  }

  const supplyAtCycleStart = totalSupply(ttState);
  const standardCap = supplyAtCycleStart * STANDARD_REDEMPTION_CAP_PCT;
  const dollarsOut = {};
  const collateralHaircuts = {};

  let mintedByUser = { ...ttState.mintedByUser };
  let penaltyToPool = 0;
  let standardDrained = 0;
  const remaining = [];

  // Snapshot minter list for stable pro-rata across all clears in
  // this cycle (using the cycle-start composition).
  const minterIds = Object.keys(mintedByUser).filter((id) => mintedByUser[id] > 0);
  const totalMintedSnapshot = minterIds.reduce(
    (s, id) => s + mintedByUser[id],
    0
  );

  function applyClear(req, hint) {
    const dollars = req.amount * (1 - req.penaltyRate);
    const penalty = req.amount * req.penaltyRate;
    dollarsOut[req.userId] = (dollarsOut[req.userId] ?? 0) + dollars;
    penaltyToPool += penalty;

    // Pro-rata reduction across every current minter's outstanding
    // mint AND a haircut of the same dollar value on each minter's
    // collateral deposit. Total haircuts === req.amount (the full
    // unit count comes off-supply); the penalty is added on top to
    // the insurance pool and doesn't touch minter collateral.
    if (totalMintedSnapshot > 0) {
      for (const minterId of minterIds) {
        const share = mintedByUser[minterId] / totalMintedSnapshot;
        const portion = req.amount * share;
        if (portion <= 0) continue;
        mintedByUser[minterId] = Math.max(0, mintedByUser[minterId] - portion);
        collateralHaircuts[minterId] =
          (collateralHaircuts[minterId] ?? 0) + portion;
      }
    }
    logs.push(
      `[TT-REDEEM ${hint}] ${req.userId} ${req.amount.toFixed(2)} TT → $${dollars.toFixed(2)}` +
        (penalty > 0 ? ` (penalty $${penalty.toFixed(2)} → pool)` : "")
    );
  }

  // Pass 1 — Express clears.
  for (const req of queue) {
    if (!req.express) {
      remaining.push(req);
      continue;
    }
    applyClear(req, "EXPRESS");
  }

  // Pass 2 — Standard clears, FIFO, capped.
  const finalRemaining = [];
  for (const req of remaining) {
    if (standardDrained + req.amount <= standardCap + 1e-6) {
      applyClear(req, "STANDARD");
      standardDrained += req.amount;
    } else {
      finalRemaining.push(req);
    }
  }

  if (finalRemaining.length > 0) {
    logs.push(
      `[TT-CYCLE] queue: ${finalRemaining.length} entries deferred ` +
        `(standardDrained $${standardDrained.toFixed(2)} of $${standardCap.toFixed(2)} cap)`
    );
  }

  return {
    ttState: {
      ...ttState,
      mintedByUser,
      redemptionQueue: finalRemaining,
      lastRedemptionEpoch: currentEpoch,
      cumulativePenaltyToPool:
        (ttState.cumulativePenaltyToPool ?? 0) + penaltyToPool,
    },
    dollarsOut,
    collateralHaircuts,
    penaltyToPool,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Solvency claw-back
// ---------------------------------------------------------------------------

// When a minter's deposit drops (via pool claim haircut), check whether
// their outstanding mint exceeds the new mint cap. If so:
//   1. Clawback from the minter's wallet TT first (they lose tokens
//      they minted but haven't spent yet).
//   2. Any remaining shortfall becomes debt — outstanding-mint stays,
//      future mints blocked until repaid via shrinking outstanding.
export function applySolvencyCheck({
  ttState,
  userId,
  newDeposit,
  ltv,
}) {
  const minted = mintedByOf(ttState, userId);
  if (minted <= 0) return { ttState, clawback: 0, newDebt: 0 };
  const newCap = (newDeposit ?? 0) * (ltv ?? 0) * MINT_COEFFICIENT;
  const overflow = minted - newCap;
  if (overflow <= 1e-6) return { ttState, clawback: 0, newDebt: 0 };

  const wallet = balanceOf(ttState, userId);
  const clawback = Math.min(wallet, overflow);
  const debt = overflow - clawback;

  const next = { ...ttState };
  if (clawback > 0) {
    next.balances = {
      ...ttState.balances,
      [userId]: wallet - clawback,
    };
    next.mintedByUser = {
      ...ttState.mintedByUser,
      [userId]: minted - clawback,
    };
  }
  if (debt > 0) {
    next.debtByUser = {
      ...ttState.debtByUser,
      [userId]: (ttState.debtByUser?.[userId] ?? 0) + debt,
    };
  }
  return { ttState: next, clawback, newDebt: debt };
}
