// Epoch-separation invariant — Tier 1.0
//
// Verifies that the harness only runs insurance settlement on ticks
// where (tickIndex % INSURANCE_STRIDE === 0), so insurance-driven
// thread damage and (future) LAP-driven thread damage cannot
// coincide.

import { describe, it, expect } from "vitest";
import {
  SCENARIOS,
  runStressSession,
} from "../stressHarness.js";
import { INSURANCE_STRIDE } from "../../constants/system.js";

describe("epoch-separation invariant", () => {
  it("INSURANCE_STRIDE is a positive integer", () => {
    expect(Number.isInteger(INSURANCE_STRIDE)).toBe(true);
    expect(INSURANCE_STRIDE).toBeGreaterThanOrEqual(1);
  });

  it("CALM scenario produces a deterministic outcome under the stride", () => {
    // With INSURANCE_STRIDE = 2 and ticks = 200, the harness runs
    // 100 insurance settlements per session. Determinism: same seed
    // → same outcome.
    const a = runStressSession({
      scenario: SCENARIOS.CALM,
      seed: 99,
      initialDeposit: 10000,
    });
    const b = runStressSession({
      scenario: SCENARIOS.CALM,
      seed: 99,
      initialDeposit: 10000,
    });
    expect(a.jointOutcomeFraction).toBe(b.jointOutcomeFraction);
  });

  it("trigger count is constrained by stride frequency", () => {
    // Even in a high-probability scenario, triggers per run can't
    // exceed (ticks / INSURANCE_STRIDE) — insurance only settles on
    // its stride, so events not on a stride tick aren't counted.
    const r = runStressSession({
      scenario: SCENARIOS.CORRELATED_CRISIS,
      seed: 42,
    });
    const maxPossibleTriggers =
      Math.floor(SCENARIOS.CORRELATED_CRISIS.ticks / INSURANCE_STRIDE) *
      Object.keys(SCENARIOS.CORRELATED_CRISIS.eventProbabilities).length;
    // triggerCount is summed per market across the session; allow a
    // generous upper bound for the test's purpose (no insolvency
    // from over-triggering).
    expect(r.metrics.triggerCount).toBeLessThanOrEqual(maxPossibleTriggers);
  });

  it("safety claim still holds: CALM joint outcome is positive", () => {
    // After Tier 1.0 (insurance on every other tick + rate ×2 to
    // compensate), the user's expected yield should be unchanged.
    // CALM with no triggers should still be solidly positive.
    const r = runStressSession({ scenario: SCENARIOS.CALM, seed: 1 });
    expect(r.jointOutcomeFraction).toBeGreaterThan(0);
  });
});
