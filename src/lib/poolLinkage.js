// Pool ↔ LAP linkage helpers.
//
// A pool-backed LAP is tethered to a depositor: credit drawn from the
// pool funds the position, and if either side takes a loss, the haircut
// propagates to the other — but on a different epoch cadence so the two
// subsystems never try to mutate the same slice in the same frame.
//
// Propagation model:
//   * pool-settle (slow tick) writes pendingLapHaircutPct[depositorId]
//   * lap-settle  (medium tick) reads it, applies to every linked LAP,
//     clears it
//   * lap-settle  (medium tick) writes pendingPoolHaircutPct[depositorId]
//     when a linked LAP loses / is liquidated
//   * pool-settle (slow tick) reads it, applies to the depositor's slice,
//     clears it, then runs normal flows
//
// All state is immutable — every helper returns new objects.

// Stable ID helper. Time-based; good enough for one session.
export function makeLapId(prefix = "LAP") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// Register a new pool-backed LAP in the depositor's linkedLaps list and
// record the deployed credit amount on the deposit.
export function linkLapToDeposit(pool, depositorId, lapId, creditConsumed) {
  const deposit = pool.deposits?.[depositorId];
  if (!deposit) return pool;
  const linkedLaps = deposit.linkedLaps ?? [];
  return {
    ...pool,
    deposits: {
      ...pool.deposits,
      [depositorId]: {
        ...deposit,
        linkedLaps: [...linkedLaps, { lapId, creditConsumed }],
        deployedCredit: (deposit.deployedCredit ?? 0) + creditConsumed,
      },
    },
  };
}

// Remove a linkage (voluntary close or liquidation). `realizedLossPct`
// is the fraction of position margin that was lost (≥ 0). It's queued
// for the next slow-tick pool settlement rather than applied in place.
export function unlinkLapFromDeposit(pool, depositorId, lapId, realizedLossPct = 0) {
  const deposit = pool.deposits?.[depositorId];
  if (!deposit) return pool;
  const linkedLaps = deposit.linkedLaps ?? [];
  const target = linkedLaps.find((l) => l.lapId === lapId);
  if (!target) return pool;

  const next = {
    ...pool,
    deposits: {
      ...pool.deposits,
      [depositorId]: {
        ...deposit,
        linkedLaps: linkedLaps.filter((l) => l.lapId !== lapId),
        deployedCredit: Math.max(0, (deposit.deployedCredit ?? 0) - target.creditConsumed),
      },
    },
  };

  // Queue a pool-side haircut if the LAP actually lost value. The pct is
  // weighted by this LAP's share of total deployed credit so one liquidated
  // LAP doesn't wipe the whole deposit.
  if (realizedLossPct > 0) {
    const shareOfCredit =
      target.creditConsumed / Math.max(1e-8, deposit.deployedCredit ?? 0);
    const queuedPct = realizedLossPct * shareOfCredit;
    const prev = next.pendingPoolHaircutPct?.[depositorId] ?? 0;
    // Compound — 1 − (1−prev)(1−queued)
    next.pendingPoolHaircutPct = {
      ...(next.pendingPoolHaircutPct ?? {}),
      [depositorId]: 1 - (1 - prev) * (1 - queuedPct),
    };
  }

  return next;
}

// Apply a queued pool→LAP haircut to every linked position. Returns the
// new positions array + the pool with the queue cleared for those
// depositors.
export function applyPoolToLapHaircut(pool, positions) {
  const haircuts = pool.pendingLapHaircutPct ?? {};
  const depositorIds = Object.keys(haircuts).filter((id) => haircuts[id] > 0);
  if (depositorIds.length === 0) return { positions, pool };

  const updatedPositions = positions.map((pos) => {
    if (!pos.poolLinkage) return pos;
    const pct = haircuts[pos.poolLinkage.depositorId] ?? 0;
    if (pct <= 0) return pos;
    return {
      ...pos,
      margin: Math.max(0, (pos.margin ?? 0) * (1 - pct)),
    };
  });

  const nextPendingLap = { ...(pool.pendingLapHaircutPct ?? {}) };
  depositorIds.forEach((id) => {
    delete nextPendingLap[id];
  });

  return {
    positions: updatedPositions,
    pool: { ...pool, pendingLapHaircutPct: nextPendingLap },
  };
}

// Apply a queued LAP→pool haircut to deposits before normal pool flows.
// Returns updated pool with haircuts applied and the queue cleared.
export function applyLapToPoolHaircut(pool) {
  const haircuts = pool.pendingPoolHaircutPct ?? {};
  const depositorIds = Object.keys(haircuts).filter((id) => haircuts[id] > 0);
  if (depositorIds.length === 0) return pool;

  const newDeposits = { ...pool.deposits };
  let totalDeposits = 0;
  Object.entries(newDeposits).forEach(([uid, d]) => {
    const pct = haircuts[uid] ?? 0;
    const nextAmount = Math.max(0, d.amount * (1 - pct));
    newDeposits[uid] = { ...d, amount: nextAmount };
    totalDeposits += nextAmount;
  });

  return {
    ...pool,
    deposits: newDeposits,
    totalDeposits,
    pendingPoolHaircutPct: {},
  };
}

// Queue a pool→LAP haircut. Called by pool settlement when a claim hits
// a depositor. pct is fraction of their LINKED LAPs' margin to remove.
export function queuePoolToLapHaircut(pool, depositorId, pct) {
  if (!pct || pct <= 0) return pool;
  const prev = pool.pendingLapHaircutPct?.[depositorId] ?? 0;
  return {
    ...pool,
    pendingLapHaircutPct: {
      ...(pool.pendingLapHaircutPct ?? {}),
      [depositorId]: 1 - (1 - prev) * (1 - pct),
    },
  };
}
