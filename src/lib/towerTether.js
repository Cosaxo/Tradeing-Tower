// Tower Tether (TT) — fully-collateralized stablecoin minted against
// insurance-market allocations.
//
// Phase 5 migration: TT no longer mints against a single "pool deposit"
// amount. The new collateral is the user's distributed allocation
// across insurance markets (where they sit as the insurer side),
// PLUS an auto-purchased reinsurance hedge that covers their downside
// if any market triggers.
//
// Mint flow
// ---------
//
//   1. Compute mintCapacity from totalAllocatedStake × LTV × MINT_COEFFICIENT.
//      - LTV is allocation-based (rewards spreading across many markets).
//      - Minimum LTV gate (MINT_LTV_GATE) prevents minting against a
//        concentrated allocation.
//
//   2. The caller (App.jsx / useEpochLoop) auto-buys reinsurance on
//      each of the 3 products with face = mintAmount × 1.5 / 3 — the
//      "1.5× rule": the user's potential payout liability never exceeds
//      150 % of reinsurance coverage on that loss.
//
//   3. mintedByUser[uid] += amount; balances[uid] += amount.
//      Total supply increments; user's outstanding mint claim grows.
//
// Redemption flow
// ---------------
//
// Per cycle, the queue drains up to STANDARD_REDEMPTION_CAP_PCT of total
// supply at the cycle start. Express requests bypass the cap, paying
// EXPRESS_PENALTY_RATE of redeemed amount to the insurance system.
//
// When a redemption clears, EVERY current minter loses pro-rata. The
// collateralHaircuts map returned by `runRedemptionCycle` should be
// applied to minters' allocations (not pool deposits) — useEpochLoop
// translates the haircut into reductions across the insurer-side
// market stakes, pro-rata to the minter's stake in each market.

import {
  MINT_COEFFICIENT,
  MINT_LTV_GATE,
  STANDARD_REDEMPTION_CAP_PCT,
  EXPRESS_PENALTY_RATE,
} from "../constants/system.js";

// 1.5× rule — when minting, the auto-purchased reinsurance face is sized
// to over-cover the mint amount by this factor (split across the 3
// reinsurance products).
export const TT_REINS_OVERSIZE = 1.5;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initTtState() {
  return {
    mintedByUser: {},
    balances: {},
    debtByUser: {},
    redemptionQueue: [],
    merchantBalance: 0,
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

// Mint capacity given the user's allocation total and LTV. The caller
// is responsible for computing the inputs from the live insurance
// markets (via calcAllocationLtv + allocationDiversificationStats).
export function mintCapacity({ ttState, userId, totalStake, ltv }) {
  if (!Number.isFinite(totalStake) || totalStake <= 0) return 0;
  if (!Number.isFinite(ltv) || ltv <= 0) return 0;
  if (ltv < MINT_LTV_GATE) return 0;
  const cap = totalStake * ltv * MINT_COEFFICIENT;
  const outstanding = mintedByOf(ttState, userId) + debtOf(ttState, userId);
  return Math.max(0, cap - outstanding);
}

// ---------------------------------------------------------------------------
// Mint / transfer / redeem
// ---------------------------------------------------------------------------

export function mintTT({ ttState, userId, amount, totalStake, ltv }) {
  if (!userId) return { ok: false, reason: "no userId" };
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: "amount must be positive" };
  }
  if (ltv < MINT_LTV_GATE) {
    return {
      ok: false,
      reason: `LTV ${ltv.toFixed(2)} below gate ${MINT_LTV_GATE.toFixed(2)}`,
    };
  }
  const capacity = mintCapacity({ ttState, userId, totalStake, ltv });
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
    // Caller uses these to size the auto-purchased reinsurance.
    reinsuranceFacePerProduct: (amount * TT_REINS_OVERSIZE) / 3,
  };
}

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
    balances: { ...ttState.balances, [fromId]: fromBal - amount },
  };
  if (toId === "MERCHANT") {
    next.merchantBalance = (ttState.merchantBalance ?? 0) + amount;
  } else {
    next.balances[toId] = (ttState.balances?.[toId] ?? 0) + amount;
  }
  return { ok: true, ttState: next };
}

let _reqCtr = 0;
const _reqId = () => `RED-${Date.now().toString(36)}-${(++_reqCtr).toString(36)}`;

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
  const fromBalance =
    userId === "MERCHANT"
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

export function cancelRedemption({ ttState, requestId }) {
  const queue = ttState.redemptionQueue ?? [];
  const idx = queue.findIndex((r) => r.id === requestId);
  if (idx < 0) return { ok: false, reason: "request not found" };
  const entry = queue[idx];
  const next = {
    ...ttState,
    redemptionQueue: queue.filter((_, i) => i !== idx),
  };
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

  // Snapshot minter list at cycle start so all clears in this cycle
  // see the same composition.
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

    // Pro-rata across every current minter — sum of haircuts === req.amount.
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

  for (const req of queue) {
    if (!req.express) continue;
    applyClear(req, "EXPRESS");
  }
  for (const req of queue) {
    if (req.express) continue;
    if (standardDrained + req.amount <= standardCap + 1e-6) {
      applyClear(req, "STANDARD");
      standardDrained += req.amount;
    } else {
      remaining.push(req);
    }
  }

  if (remaining.length > 0) {
    logs.push(
      `[TT-CYCLE] queue: ${remaining.length} entries deferred (drained $${standardDrained.toFixed(2)} of $${standardCap.toFixed(2)} cap)`
    );
  }

  return {
    ttState: {
      ...ttState,
      mintedByUser,
      redemptionQueue: remaining,
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

// When a minter's allocation total drops (LAP loss propagating through
// allocations, or a market trigger), recheck their mint cap. Overflow
// is clawed back from wallet TT first; remainder becomes debt.
export function applySolvencyCheck({
  ttState,
  userId,
  newTotalStake,
  ltv,
}) {
  const minted = mintedByOf(ttState, userId);
  if (minted <= 0) return { ttState, clawback: 0, newDebt: 0 };
  const newCap = (newTotalStake ?? 0) * (ltv ?? 0) * MINT_COEFFICIENT;
  const overflow = minted - newCap;
  if (overflow <= 1e-6) return { ttState, clawback: 0, newDebt: 0 };

  const wallet = balanceOf(ttState, userId);
  const clawback = Math.min(wallet, overflow);
  const debt = overflow - clawback;

  const next = { ...ttState };
  if (clawback > 0) {
    next.balances = { ...ttState.balances, [userId]: wallet - clawback };
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
