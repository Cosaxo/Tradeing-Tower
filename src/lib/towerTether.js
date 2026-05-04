// Tower Tether (TT) — thread-based, hyper-rehypothecated stablecoin.
//
// A "thread" is one unit of value backed by the SAME dollar serving four
// roles simultaneously, each carrying full notional:
//
//   1. T-bill stake          (Floor 1 — the underlying asset)
//   2. Insurance-seller stakes spread across reinsurance-covered markets
//   3. B-book pool underwriter stake (the protocol's open counterparty
//      pool for B-classified user flow — earns user tip income +
//      absorbs their directional P&L pro-rata)
//   4. TT in circulation
//
// Mint is 1:1 against free margin — no LTV gate, no coefficient. The
// gating constraint is "do you have $X of free margin to commit to all
// four layers at once?" When a holder later redeems, that fraction of
// the originating thread's T-bill is sold to pay them in dollars and
// the remaining three layers shrink by the same amount atomically.
//
// Loss propagation ("thread damage")
// ----------------------------------
// If any layer of a thread loses $L, the thread's underlying integrity
// drops by $L → ALL four layers shrink by $L. This is what the user
// gives up in exchange for the rehypothecation: a loss in any role
// hits every other role simultaneously. Mint timing is structured so
// loss-on-mint is near-impossible.
//
// Critical invariant (enforced structurally in the epoch loop): the
// insurance damage path and the LAP / B-book damage path run on
// COPRIME STRIDES so they never coincide on the same medium tick.
// Insurance settles every INSURANCE_STRIDE ticks (default 2); LAP /
// B-book damage runs on the OFF-stride (when wired in Tier 1.1).
// One thread principal can never be debited by two damage sources
// in the same tick. See useEpochLoop.js for the enforcement.
//
// State shape
// -----------
//   {
//     threads:   Thread[],        // active + closed (closed kept for audit)
//     balances:  { [uid]: TT },   // wallet TT
//     redemptionQueue: [...],     // pending redemption requests
//     merchantBalance: number,
//     debtByUser: { [uid]: $ },   // shortfall when wallet doesn't cover claw-back
//     lastRedemptionEpoch: number,
//     cumulativePenaltyToPool: number,
//   }
//
//   Thread {
//     id, ownerId, createdAtEpoch,
//     principal,                  // T-bill stake (current)
//     ttFace,                     // outstanding TT minted from this thread
//     insuranceWeights: { [eventId]: weight }, // sum ≈ 1
//     closed: boolean,
//   }
//
//   Layer 3 lives in bBookPool.js as the user's threadDerivedStake.
//   The thread's principal IS its contribution to the pool; they
//   stay in lockstep via adjustThreadDerived calls in the App layer.
//
//   `mintedByUser[uid]` is derived from threads (sum of ttFace per owner)
//   so we don't have to keep two maps in sync. See `mintedByOf`.

import {
  STANDARD_REDEMPTION_CAP_PCT,
  EXPRESS_PENALTY_RATE,
} from "../constants/system.js";

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

let _threadCtr = 0;
const _threadId = () => `THR-${Date.now().toString(36)}-${(++_threadCtr).toString(36)}`;
let _reqCtr = 0;
const _reqId = () => `RED-${Date.now().toString(36)}-${(++_reqCtr).toString(36)}`;

// ---------------------------------------------------------------------------
// State factory
// ---------------------------------------------------------------------------

export function initTtState() {
  return {
    threads: [],
    balances: {},
    debtByUser: {},
    redemptionQueue: [],
    merchantBalance: 0,
    lastRedemptionEpoch: -1,
    cumulativePenaltyToPool: 0,
  };
}

// ---------------------------------------------------------------------------
// Derived accessors
// ---------------------------------------------------------------------------

export function activeThreads(ttState) {
  return (ttState?.threads ?? []).filter((t) => !t.closed && t.ttFace > 1e-9);
}

export function threadsOf(ttState, ownerId) {
  return activeThreads(ttState).filter((t) => t.ownerId === ownerId);
}

export function totalSupply(ttState) {
  return activeThreads(ttState).reduce((s, t) => s + t.ttFace, 0);
}

export function totalCirculating(ttState) {
  const balances = Object.values(ttState?.balances ?? {}).reduce((s, v) => s + v, 0);
  return balances + (ttState?.merchantBalance ?? 0);
}

export function balanceOf(ttState, userId) {
  return ttState?.balances?.[userId] ?? 0;
}

export function mintedByOf(ttState, userId) {
  return threadsOf(ttState, userId).reduce((s, t) => s + t.ttFace, 0);
}

export function debtOf(ttState, userId) {
  return ttState?.debtByUser?.[userId] ?? 0;
}

// Principal currently locked across a user's active threads. Useful for
// the UI's "thread stake" chip.
export function totalThreadPrincipal(ttState, userId) {
  return threadsOf(ttState, userId).reduce((s, t) => s + t.principal, 0);
}

// ---------------------------------------------------------------------------
// Insurance fill weights
// ---------------------------------------------------------------------------

// Compute the per-market fill weights for a new thread's insurance
// layer. The mix:
//
//   weight_i = 0.5 × (1/N) + 0.5 × size_i / Σsize
//
// - Even floor: every eligible market gets some flow even if it's tiny,
//   so newly-launched markets aren't ignored.
// - Size tilt: the bulk follows liquidity (bigger markets absorb more).
//
// `eligibleMarkets` are the markets that have any active reinsurance
// backing — i.e. at least one reinsurance product carries seller capital
// AND the market itself exists. Falls back to pure equal weight when
// reinsurance is empty (so the 1.5× rule is degenerate).
export function calcInsuranceFillWeights({ eligibleMarkets, reinsuranceLive }) {
  const n = eligibleMarkets.length;
  if (n === 0) return {};
  const equal = 1 / n;
  if (!reinsuranceLive) {
    return Object.fromEntries(eligibleMarkets.map((m) => [m.eventId, equal]));
  }
  const totalSize = eligibleMarkets.reduce(
    (s, m) => s + Math.max(0, m.insurerCapital ?? 0),
    0
  );
  if (totalSize <= 0) {
    return Object.fromEntries(eligibleMarkets.map((m) => [m.eventId, equal]));
  }
  const out = {};
  for (const m of eligibleMarkets) {
    const sizeShare = Math.max(0, m.insurerCapital ?? 0) / totalSize;
    out[m.eventId] = 0.5 * equal + 0.5 * sizeShare;
  }
  // Renormalise (floating drift can push the sum a hair off 1).
  const sum = Object.values(out).reduce((s, v) => s + v, 0);
  if (sum > 0) {
    for (const k of Object.keys(out)) out[k] = out[k] / sum;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Open a new thread (mint)
// ---------------------------------------------------------------------------

// Build a new thread record. Caller is responsible for:
//   - posting the insurance stakes via the allocations / market helpers
//   - depositing the principal into bBookPool as thread-derived stake
//   - tagging the user's margin for `principal`
//   - auto-buying reinsurance (the 1.5× rule) to hedge the insurer-side
//
// This module owns the thread bookkeeping + TT mint. The atomic
// orchestration lives in App.jsx (handleMintTT).
//
// Returns { ok, ttState, thread, reason? }.
export function openThread({
  ttState,
  ownerId,
  principal,
  insuranceWeights,
  currentEpoch,
}) {
  if (!ownerId) return { ok: false, reason: "no ownerId" };
  if (!Number.isFinite(principal) || principal <= 0) {
    return { ok: false, reason: "principal must be positive" };
  }
  const thread = {
    id: _threadId(),
    ownerId,
    createdAtEpoch: currentEpoch ?? 0,
    principal,
    ttFace: principal, // 1:1 mint
    insuranceWeights: { ...(insuranceWeights ?? {}) },
    closed: false,
  };
  return {
    ok: true,
    ttState: {
      ...ttState,
      threads: [...(ttState.threads ?? []), thread],
      balances: {
        ...ttState.balances,
        [ownerId]: (ttState.balances?.[ownerId] ?? 0) + principal,
      },
    },
    thread,
  };
}

// ---------------------------------------------------------------------------
// Damage propagation
// ---------------------------------------------------------------------------

// Apply a loss to a single thread's principal. ALL four layers shrink
// by `delta`. Returns:
//
//   {
//     ttState,
//     deltaApplied,                 // actual amount written down (capped at principal)
//     insuranceLayerDeltas,         // { [eventId]: amountToWithdrawFromMarket }
//     poolLayerDelta,               // amount to remove from B-book threadDerivedStake
//     ttFaceDelta,                  // shrink in mintedByUser / outstanding TT
//   }
//
// The caller (epoch loop / App handlers) is responsible for actually
// mutating the insurance markets and bBookPool state using these
// deltas (via withdrawInsurer + adjustThreadDerived).
export function damageThread({ ttState, threadId, delta }) {
  if (!Number.isFinite(delta) || delta <= 0) {
    return {
      ttState,
      deltaApplied: 0,
      insuranceLayerDeltas: {},
      poolLayerDelta: 0,
      ttFaceDelta: 0,
    };
  }
  const threads = ttState.threads ?? [];
  const idx = threads.findIndex((t) => t.id === threadId);
  if (idx < 0) {
    return {
      ttState,
      deltaApplied: 0,
      insuranceLayerDeltas: {},
      poolLayerDelta: 0,
      ttFaceDelta: 0,
    };
  }
  const t = threads[idx];
  if (t.closed || t.principal <= 0) {
    return {
      ttState,
      deltaApplied: 0,
      insuranceLayerDeltas: {},
      poolLayerDelta: 0,
      ttFaceDelta: 0,
    };
  }
  const applied = Math.min(t.principal, delta);
  const newPrincipal = t.principal - applied;
  // ttFace can't exceed principal; shrink it pro-rata if needed.
  const newTtFace = Math.min(t.ttFace, newPrincipal);
  const ttFaceDelta = t.ttFace - newTtFace;

  const insuranceLayerDeltas = {};
  for (const [eventId, w] of Object.entries(t.insuranceWeights ?? {})) {
    insuranceLayerDeltas[eventId] = applied * w;
  }

  const updatedThread = {
    ...t,
    principal: newPrincipal,
    ttFace: newTtFace,
    closed: newPrincipal <= 1e-9,
  };
  const newThreads = threads.map((x, i) => (i === idx ? updatedThread : x));

  return {
    ttState: { ...ttState, threads: newThreads },
    deltaApplied: applied,
    insuranceLayerDeltas,
    poolLayerDelta: applied,
    ttFaceDelta,
  };
}

// ---------------------------------------------------------------------------
// Growth propagation
// ---------------------------------------------------------------------------

// Apply a gain to a single thread. Principal grows; layers 1, 2, and 3
// fatten by the same amount. Layer 4 (ttFace) is INTENTIONALLY not
// touched — TT supply only expands on a deliberate mint event, never
// from passive yield. The buffer (principal - ttFace) acts as
// over-collateralisation: subsequent damage eats the buffer before
// ttFace starts shrinking.
//
// Returns:
//   {
//     ttState,                      // thread.principal incremented
//     gainApplied,                  // actual amount written up
//     insuranceLayerAdds,           // { [eventId]: amountToPostAsInsurer }
//     poolLayerAdd,                 // amount to add to bBookPool threadDerivedStake
//   }
//
// The caller is responsible for:
//   - posting additional insurer stakes via postInsurer
//   - growing the user's threadDerivedStake via adjustThreadDerived
//
// T-bill is the principal itself, so no separate caller action is
// needed for layer 1.
export function growThread({ ttState, threadId, gain }) {
  if (!Number.isFinite(gain) || gain <= 0) {
    return {
      ttState,
      gainApplied: 0,
      insuranceLayerAdds: {},
      poolLayerAdd: 0,
    };
  }
  const threads = ttState.threads ?? [];
  const idx = threads.findIndex((t) => t.id === threadId);
  if (idx < 0) {
    return {
      ttState,
      gainApplied: 0,
      insuranceLayerAdds: {},
      poolLayerAdd: 0,
    };
  }
  const t = threads[idx];
  if (t.closed) {
    return {
      ttState,
      gainApplied: 0,
      insuranceLayerAdds: {},
      poolLayerAdd: 0,
    };
  }
  const insuranceLayerAdds = {};
  for (const [eventId, w] of Object.entries(t.insuranceWeights ?? {})) {
    insuranceLayerAdds[eventId] = gain * w;
  }
  const updatedThread = {
    ...t,
    principal: t.principal + gain,
    // ttFace UNCHANGED — gains never auto-mint TT.
  };
  const newThreads = threads.map((x, i) => (i === idx ? updatedThread : x));
  return {
    ttState: { ...ttState, threads: newThreads },
    gainApplied: gain,
    insuranceLayerAdds,
    poolLayerAdd: gain,
  };
}

// ---------------------------------------------------------------------------
// TT transfer / redemption queue
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Redemption cycle
// ---------------------------------------------------------------------------

// Drain the redemption queue: express requests bypass the cap and pay
// the penalty; standard requests respect the per-cycle cap and FIFO.
//
// For each cleared request, we walk the active threads in createdAtEpoch
// order (oldest first — discrete-thread FIFO) and shrink their layers
// until the request is satisfied. The returned `threadUnwinds` tells
// the epoch loop:
//   - which thread shrank by how much (so it can withdraw insurance
//     stakes per market and shrink the paired LAP)
//   - which TT face came out of which minter (so it can update
//     mintedByUser-driven UI / accounting)
//
// Returns:
//   {
//     ttState,
//     dollarsOut,            // { redeemerUid: $ }
//     threadUnwinds,         // [{ threadId, ownerId, delta, insuranceLayerDeltas, poolLayerDelta }]
//     penaltyToPool,         // express-penalty $ (epoch loop routes to reinsurance sellers)
//     logs,
//   }
export function runRedemptionCycle({ ttState, currentEpoch }) {
  const logs = [];
  const queue = [...(ttState.redemptionQueue ?? [])];
  if (queue.length === 0) {
    return {
      ttState: { ...ttState, lastRedemptionEpoch: currentEpoch },
      dollarsOut: {},
      threadUnwinds: [],
      penaltyToPool: 0,
      logs,
    };
  }

  const supplyAtCycleStart = totalSupply(ttState);
  const standardCap = supplyAtCycleStart * STANDARD_REDEMPTION_CAP_PCT;
  const dollarsOut = {};
  const threadUnwinds = [];
  let workingTt = ttState;
  let penaltyToPool = 0;
  let standardDrained = 0;
  const remaining = [];

  function clearOne(req, hint) {
    const dollars = req.amount * (1 - req.penaltyRate);
    const penalty = req.amount * req.penaltyRate;
    dollarsOut[req.userId] = (dollarsOut[req.userId] ?? 0) + dollars;
    penaltyToPool += penalty;

    // Walk threads oldest-first, shrinking each by the amount needed.
    let amountLeft = req.amount;
    const sortedThreads = activeThreads(workingTt)
      .slice()
      .sort((a, b) => a.createdAtEpoch - b.createdAtEpoch);
    for (const t of sortedThreads) {
      if (amountLeft <= 1e-9) break;
      const take = Math.min(t.ttFace, amountLeft);
      if (take <= 1e-9) continue;
      const dmg = damageThread({
        ttState: workingTt,
        threadId: t.id,
        delta: take,
      });
      if (dmg.deltaApplied <= 1e-9) continue;
      workingTt = dmg.ttState;
      threadUnwinds.push({
        threadId: t.id,
        ownerId: t.ownerId,
        delta: dmg.deltaApplied,
        insuranceLayerDeltas: dmg.insuranceLayerDeltas,
        poolLayerDelta: dmg.poolLayerDelta,
      });
      amountLeft -= dmg.deltaApplied;
    }

    logs.push(
      `[TT-REDEEM ${hint}] ${req.userId} ${req.amount.toFixed(2)} TT → $${dollars.toFixed(2)}` +
        (penalty > 0 ? ` (penalty $${penalty.toFixed(2)} → pool)` : "")
    );
  }

  // Express first (bypasses cap), then standard up to cap.
  for (const req of queue) {
    if (!req.express) continue;
    clearOne(req, "EXPRESS");
  }
  for (const req of queue) {
    if (req.express) continue;
    if (standardDrained + req.amount <= standardCap + 1e-6) {
      clearOne(req, "STANDARD");
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
      ...workingTt,
      redemptionQueue: remaining,
      lastRedemptionEpoch: currentEpoch,
      cumulativePenaltyToPool:
        (workingTt.cumulativePenaltyToPool ?? 0) + penaltyToPool,
    },
    dollarsOut,
    threadUnwinds,
    penaltyToPool,
    logs,
  };
}

// ---------------------------------------------------------------------------
// Solvency check
// ---------------------------------------------------------------------------

// Outstanding TT mint can drift above the principal that backs it (e.g.
// after a chain of damage events). When that happens, claw back from the
// minter's wallet TT first; remainder becomes debt. Wallet TT clawed
// back is destroyed (reduces ttFace on their oldest threads pro-rata).
//
// Returns { ttState, clawback, newDebt }.
export function applySolvencyCheck({ ttState, userId }) {
  const owned = threadsOf(ttState, userId);
  if (owned.length === 0) return { ttState, clawback: 0, newDebt: 0 };
  const totalFace = owned.reduce((s, t) => s + t.ttFace, 0);
  const totalPrincipal = owned.reduce((s, t) => s + t.principal, 0);
  const overflow = totalFace - totalPrincipal;
  if (overflow <= 1e-6) return { ttState, clawback: 0, newDebt: 0 };

  const wallet = balanceOf(ttState, userId);
  const clawback = Math.min(wallet, overflow);
  const debt = overflow - clawback;

  let next = { ...ttState };
  if (clawback > 0) {
    next.balances = { ...ttState.balances, [userId]: wallet - clawback };
    // Burn ttFace from oldest threads first — match the FIFO rule used
    // by redemptions so the audit trail is consistent.
    let amountLeft = clawback;
    next.threads = (ttState.threads ?? []).map((t) => {
      if (t.ownerId !== userId || t.closed || amountLeft <= 1e-9) return t;
      const burn = Math.min(t.ttFace, amountLeft);
      amountLeft -= burn;
      return { ...t, ttFace: t.ttFace - burn };
    });
  }
  if (debt > 0) {
    next.debtByUser = {
      ...ttState.debtByUser,
      [userId]: (ttState.debtByUser?.[userId] ?? 0) + debt,
    };
  }
  return { ttState: next, clawback, newDebt: debt };
}
