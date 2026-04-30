// Allocation system — replaces the old "pool deposit".
//
// In the new model, the user's "deposit" is a vector of percentage
// allocations across the insurance markets. They explicitly declare
// what fraction of their working capital should sit in each market
// (as the insurer side, earning premiums and bearing event risk).
//
// Roles served simultaneously by the same allocated capital:
//
//   - Insurer in each chosen insurance market (premium income)
//   - Backing for LAP credit (LTV measured on diversification of allocations)
//   - Backing for TT mint (auto-distributed within the 1.5×-reinsurance constraint)
//   - Protected by the 3 reinsurance products (which TT minters auto-buy)
//
// LAP P&L propagates directly to the allocated stakes — gains grow the
// stakes, losses shrink them — pro-rata to current allocation share.
//
// Allocation state shape (per user):
//
//   {
//     allocations: { [marketId]: pct }, // pct in [0, 1], should sum ≤ 1
//     version: integer,                  // bumped on each declaration
//     pendingLapPnl: number,              // queued P&L to apply on next settle
//   }

import {
  postInsurer,
  withdrawInsurer,
  totalInsurerStake,
} from "./insuranceMarket.js";

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

export function initAllocationsState() {
  return { byUser: {} };
}

export function getUserAllocation(allocations, userId) {
  return (
    allocations?.byUser?.[userId] ?? {
      allocations: {},
      version: 0,
      pendingLapPnl: 0,
    }
  );
}

export function setUserAllocation(allocations, userId, marketAllocations) {
  // Validate: each pct in [0,1], sum ≤ 1.
  for (const v of Object.values(marketAllocations)) {
    if (!Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, reason: "each allocation must be in [0,1]" };
    }
  }
  const sum = Object.values(marketAllocations).reduce((s, v) => s + v, 0);
  if (sum > 1 + 1e-9) {
    return { ok: false, reason: `sum of allocations exceeds 1 (got ${sum.toFixed(4)})` };
  }
  const prev = getUserAllocation(allocations, userId);
  return {
    ok: true,
    allocations: {
      ...allocations,
      byUser: {
        ...allocations.byUser,
        [userId]: {
          ...prev,
          allocations: { ...marketAllocations },
          version: (prev.version ?? 0) + 1,
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Apply allocations to markets
// ---------------------------------------------------------------------------

// Given the user's declared percentage allocations and a target total
// capital amount, produce updated insurance markets where the user's
// insurer stake on each market matches `pct × totalCapital`.
//
// This is the materialization step: percentages → actual stakes.
//
// Inputs:
//   markets         — list of insurance markets
//   userId
//   userAllocation  — { allocations: { marketId: pct }, ... }
//   totalCapital    — current working capital to allocate
//
// Returns { markets } with the user's positions resized.
export function applyAllocations({ markets, userId, userAllocation, totalCapital }) {
  if (!userAllocation || !userAllocation.allocations) return { markets };
  const targetByMarketId = {};
  for (const [mid, pct] of Object.entries(userAllocation.allocations)) {
    targetByMarketId[mid] = pct * Math.max(0, totalCapital);
  }
  const out = markets.map((m) => {
    const target = targetByMarketId[m.id] ?? 0;
    const current = m.insurerPositions?.[userId] ?? 0;
    const delta = target - current;
    if (Math.abs(delta) < 1e-6) return m;
    if (delta > 0) {
      const r = postInsurer({ market: m, userId, amount: delta });
      return r.ok ? r.market : m;
    }
    const r = withdrawInsurer({ market: m, userId, amount: -delta });
    return r.ok ? r.market : m;
  });
  return { markets: out };
}

// ---------------------------------------------------------------------------
// LAP P&L propagation
// ---------------------------------------------------------------------------

// Apply a LAP P&L event to the user's allocations. Gains grow each
// stake pro-rata to the user's current insurer stake on each market;
// losses shrink them. If the user has no insurer stake anywhere, the
// P&L queues into pendingLapPnl for later application (typically when
// they next allocate).
//
// Inputs:
//   markets   — current insurance market list
//   userId
//   lapPnl    — signed P&L (positive = gain)
//
// Returns:
//   { markets, applied: number, residual: number }
//     applied  — how much of the lapPnl actually moved into stakes
//     residual — uncovered P&L that must be queued or applied to margin
export function propagateLapPnl({ markets, userId, lapPnl }) {
  if (!Number.isFinite(lapPnl) || lapPnl === 0) {
    return { markets, applied: 0, residual: 0 };
  }
  const totalStake = totalInsurerStake(markets, userId);
  if (totalStake <= 0) {
    // User has no allocation; nothing to apply, residual is the full pnl.
    return { markets, applied: 0, residual: lapPnl };
  }

  const isLoss = lapPnl < 0;
  const magnitude = Math.abs(lapPnl);
  const pct = Math.min(1, magnitude / totalStake); // can't lose more than 100%
  const out = markets.map((m) => {
    const stake = m.insurerPositions?.[userId] ?? 0;
    if (stake <= 0) return m;
    const delta = isLoss ? -stake * pct : stake * (magnitude / totalStake);
    if (Math.abs(delta) < 1e-9) return m;
    if (delta > 0) {
      const r = postInsurer({ market: m, userId, amount: delta });
      return r.ok ? r.market : m;
    }
    const r = withdrawInsurer({ market: m, userId, amount: -delta });
    return r.ok ? r.market : m;
  });
  // residual: if we floored at -100% loss, anything beyond is unrecovered
  const applied = isLoss ? -totalStake * pct : magnitude;
  const residual = lapPnl - applied;
  return { markets: out, applied, residual };
}

// ---------------------------------------------------------------------------
// LTV inputs
// ---------------------------------------------------------------------------

// Compute diversification stats over a user's allocation. These feed
// the LTV formula in ltv.js (allocation-based replacement for the
// portfolio-based metric used in the pool era).
//
// Returns:
//   { numMarkets, hhi, maxWeight, shannonNorm, totalStake }
export function allocationDiversificationStats({ markets, userId }) {
  const stakes = [];
  for (const m of markets) {
    const s = m.insurerPositions?.[userId] ?? 0;
    if (s > 0) stakes.push(s);
  }
  const total = stakes.reduce((s, v) => s + v, 0);
  if (total <= 0) {
    return {
      numMarkets: 0,
      hhi: 1,
      maxWeight: 1,
      shannonNorm: 0,
      totalStake: 0,
    };
  }
  const weights = stakes.map((s) => s / total);
  const hhi = weights.reduce((s, w) => s + w * w, 0);
  const maxWeight = Math.max(...weights);
  // Normalised Shannon over the actual market count in the registry.
  const totalMarkets = Math.max(1, markets.length);
  const shannon = weights.reduce((s, w) => (w > 0 ? s - w * Math.log(w) : s), 0);
  const shannonNorm = shannon / Math.log(totalMarkets);
  return {
    numMarkets: stakes.length,
    hhi,
    maxWeight,
    shannonNorm,
    totalStake: total,
  };
}
