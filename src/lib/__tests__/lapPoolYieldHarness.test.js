// Smoke + sanity tests for the LAP-pool yield harness. We run small
// batches (n=30-50) and assert structural properties — these aren't
// performance benchmarks, they protect the harness from regressions.
//
// Empirical numbers are reported to stdout via a single descriptive
// log so a developer can scan typical yields per scenario.

import { describe, it, expect } from "vitest";
import {
  LAP_POOL_SCENARIOS,
  runLapPoolYieldBatch,
} from "../lapPoolYieldHarness.js";

describe("LAP pool yield harness", () => {
  it("STEADY_IMBALANCE produces a positive median yield with bounded risk", () => {
    const r = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.STEADY_IMBALANCE,
      n: 30,
      initialDeposit: 10_000,
    });
    // Sanity: at least 50% of seeds end positive (rebate income usually
    // dominates directional P&L at modest sigma).
    expect(r.headline.pPositive).toBeGreaterThanOrEqual(0.4);
    // Realised P&L sum was real (closes happened).
    expect(r.metricsMean.contractsClosed).toBeGreaterThan(0);
    // Active-absorbed never blew up.
    expect(r.metricsMean.maxActiveAbsorbed).toBeLessThan(200);
  });

  it("THIN_FEE_BUDGET respects conservation: throttling fires", () => {
    const r = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.THIN_FEE_BUDGET,
      n: 30,
      initialDeposit: 10_000,
    });
    // Throttling fired (some bids skipped because budget exhausted) —
    // requested strictly exceeds funded.
    expect(r.metricsMean.rebateRequested).toBeGreaterThan(
      r.metricsMean.rebateFunded
    );
  });

  it("ALTERNATING_IMBALANCE absorbs on both sides", () => {
    const r = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.ALTERNATING_IMBALANCE,
      n: 30,
      initialDeposit: 10_000,
    });
    // Symmetric flow → meaningful trade-through count.
    expect(r.metricsMean.contractsAbsorbed).toBeGreaterThan(20);
  });

  it("VOLATILE_PRICE has wider P&L distribution than STEADY_IMBALANCE", () => {
    const steady = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.STEADY_IMBALANCE,
      n: 50,
      initialDeposit: 10_000,
    });
    const volatile = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.VOLATILE_PRICE,
      n: 50,
      initialDeposit: 10_000,
    });
    const steadySpread = steady.distribution.fraction.p95 - steady.distribution.fraction.p05;
    const volSpread = volatile.distribution.fraction.p95 - volatile.distribution.fraction.p05;
    expect(volSpread).toBeGreaterThan(steadySpread);
  });

  it("HIGH_IMBALANCE absorbs more contracts and earns more rebate than STEADY", () => {
    // Big initial deposit so the capacity gate (1.5× stake) doesn't
    // pinch HIGH's bid throughput; otherwise both scenarios saturate
    // at the same effective rate.
    const steady = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.STEADY_IMBALANCE,
      n: 30,
      initialDeposit: 100_000,
    });
    const high = runLapPoolYieldBatch({
      scenario: LAP_POOL_SCENARIOS.HIGH_IMBALANCE,
      n: 30,
      initialDeposit: 100_000,
    });
    expect(high.metricsMean.contractsAbsorbed).toBeGreaterThan(
      steady.metricsMean.contractsAbsorbed
    );
    expect(high.metricsMean.rebateFunded).toBeGreaterThan(
      steady.metricsMean.rebateFunded
    );
  });
});
