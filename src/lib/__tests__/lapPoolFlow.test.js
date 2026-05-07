// Integration test for the LAP-pool flow end-to-end:
//
// - 50-tick simulation with sustained imbalanced order flow
// - rebate is funded from a fixed per-tick stability-fee budget
//   (mimicking what the epoch loop does)
// - maintenance pass closes aged contracts so activeAbsorbed never
//   grows monotonically
// - conservation: pool stake growth ≤ total funding drawn from the fee
//   budget across the run; closeAbsorbed P&L sum is finite and bounded
//
// This is the test that protects against the two original integration
// bugs surfaced in the deep dive: tips materialising from nothing, and
// activeAbsorbed growing forever.

import { describe, it, expect } from "vitest";
import {
  initLapPoolState,
  adjustThreadDerived,
  absorbImbalance,
  distributeRebate,
  maintainAbsorbed,
  totalActiveNotional,
} from "../lapPool.js";
import { LAP_POOL_HOLD_EPOCHS } from "../../constants/system.js";

describe("LAP pool flow — funded absorption + aged-out maintenance", () => {
  function imbalancedBids(epoch) {
    // Always 3 unmatched longs, no shorts. Each $1000 × 1× × 0.02 = $20
    // tip per bid. Pool would request $60/tick if budget allowed.
    return Array.from({ length: 3 }, (_, i) => ({
      id: `U-${epoch}-${i}`,
      base_margin: 1000,
      max_lev: 1,
      tip_tiers: [{ tip: 0.02 }],
      activePair: "BTCUSD",
    }));
  }

  it("respects the stability-fee budget across a long run", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "LP", delta: 50_000 }).state;
    const initialStake = s.totalStake;

    const TICKS = 50;
    const FEE_PER_TICK = 25; // budget < requested ($60/tick) — must throttle

    let totalFunded = 0;
    let totalRequested = 0;
    let totalClosedPnl = 0;
    let priceWalk = 100;

    for (let t = 0; t < TICKS; t++) {
      // Slight random walk so age-out closes produce real P&L.
      priceWalk *= 1 + (t % 2 === 0 ? 0.001 : -0.001);

      const absorb = absorbImbalance({
        state: s,
        unmatchedLongs: imbalancedBids(t),
        unmatchedShorts: [],
        normWeights: [1],
        bucketLevs: [1],
        openPrice: priceWalk,
        currentEpoch: t,
        rebateBudget: FEE_PER_TICK,
      });
      s = absorb.state;
      totalFunded += absorb.totalRebate;
      totalRequested += absorb.rebateRequested;

      if (absorb.totalRebate > 0) {
        s = distributeRebate({ state: s, totalRebate: absorb.totalRebate }).state;
      }

      // Maintenance: close any contracts past hold age.
      const maint = maintainAbsorbed({
        state: s,
        pricesByPair: { BTCUSD: priceWalk },
        currentEpoch: t,
        maxHoldEpochs: LAP_POOL_HOLD_EPOCHS,
      });
      s = maint.state;
      totalClosedPnl += maint.totalRealizedPnl;
    }

    // 1. Funded never exceeded budget.
    expect(totalFunded).toBeLessThanOrEqual(FEE_PER_TICK * TICKS + 1e-6);

    // 2. Throttling actually happened (requested > funded means budget
    //    was the binding constraint at least once).
    expect(totalRequested).toBeGreaterThan(totalFunded);

    // 3. Pool stake growth has a clean bound:
    //    finalStake - initialStake ≤ totalFunded + totalClosedPnl
    //    (rebate income + realised directional P&L). No "free" stake.
    const stakeGrowth = s.totalStake - initialStake;
    expect(stakeGrowth).toBeLessThanOrEqual(totalFunded + totalClosedPnl + 1e-6);

    // 4. activeAbsorbed didn't grow forever — bounded by hold-window
    //    × per-tick absorption rate. With 1-3 absorbed per tick and a
    //    20-tick hold window, the upper bound is ~60 contracts at any
    //    instant.
    expect(s.activeAbsorbed.length).toBeLessThan(80);

    // 5. cumulativeRebateIncome equals total funded (consistency check
    //    on the bookkeeping field).
    expect(s.cumulativeRebateIncome).toBeCloseTo(totalFunded, 6);
  });

  it("with zero fee budget the pool absorbs nothing — pure conservation gate", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "LP", delta: 10_000 }).state;
    const initialStake = s.totalStake;

    for (let t = 0; t < 10; t++) {
      const absorb = absorbImbalance({
        state: s,
        unmatchedLongs: imbalancedBids(t),
        unmatchedShorts: [],
        normWeights: [1],
        bucketLevs: [1],
        openPrice: 100,
        currentEpoch: t,
        rebateBudget: 0,
      });
      s = absorb.state;
    }

    expect(s.totalStake).toBe(initialStake);
    expect(s.activeAbsorbed).toHaveLength(0);
    expect(totalActiveNotional(s)).toBe(0);
  });

  it("aged-out maintenance prevents unbounded activeAbsorbed growth", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "LP", delta: 100_000 }).state;

    // Run 100 ticks with NO maintenance — pool fills up indefinitely.
    let sNoMaint = s;
    for (let t = 0; t < 100; t++) {
      sNoMaint = absorbImbalance({
        state: sNoMaint,
        unmatchedLongs: imbalancedBids(t),
        unmatchedShorts: [],
        openPrice: 100,
        currentEpoch: t,
        rebateBudget: 1000,
      }).state;
    }
    const noMaintCount = sNoMaint.activeAbsorbed.length;

    // Same run WITH maintenance.
    let sWithMaint = s;
    for (let t = 0; t < 100; t++) {
      sWithMaint = absorbImbalance({
        state: sWithMaint,
        unmatchedLongs: imbalancedBids(t),
        unmatchedShorts: [],
        openPrice: 100,
        currentEpoch: t,
        rebateBudget: 1000,
      }).state;
      sWithMaint = maintainAbsorbed({
        state: sWithMaint,
        pricesByPair: { BTCUSD: 100 },
        currentEpoch: t,
        maxHoldEpochs: LAP_POOL_HOLD_EPOCHS,
      }).state;
    }
    const withMaintCount = sWithMaint.activeAbsorbed.length;

    // With maintenance, contract count plateaus near hold-window × rate;
    // without, it grows linearly with ticks (capped by capacity gate).
    expect(withMaintCount).toBeLessThan(noMaintCount);
  });
});
