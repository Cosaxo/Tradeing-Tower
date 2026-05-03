import { describe, it, expect } from "vitest";
import {
  SCENARIOS,
  runStressSession,
  runStressBatch,
} from "../stressHarness.js";

describe("runStressSession", () => {
  it("CALM scenario produces a finite, bounded joint outcome", () => {
    const r = runStressSession({
      scenario: SCENARIOS.CALM,
      seed: 42,
      initialDeposit: 10000,
    });
    expect(r.scenarioId).toBe("CALM");
    expect(r.initialDeposit).toBe(10000);
    expect(Number.isFinite(r.finalWealth)).toBe(true);
    expect(Number.isFinite(r.annualisedYield)).toBe(true);
    // Sanity bounds — neither total wipeout nor implausible 10x in
    // 200 days. The actual headline value depends on protocol
    // calibration; the harness exists to *measure* this number, not
    // assert a particular value.
    expect(r.jointOutcomeFraction).toBeGreaterThan(-1.0);
    expect(r.jointOutcomeFraction).toBeLessThan(1.0);
  });

  it("surfaces the reinsurance-premium drag finding in default config", () => {
    // KNOWN FINDING: with the current auto-mint config (1.5× face
    // reinsurance) and a balanced 1:1 insurance demand, reinsurance
    // premium cost exceeds insurance premium income across a calm
    // run. This is what the harness exists to expose; tuning is a
    // future-sprint task.
    const r = runStressSession({ scenario: SCENARIOS.CALM, seed: 1 });
    const insuranceNet = r.metrics.premiumIn - r.metrics.premiumOut;
    const reinsuranceNet =
      r.metrics.reinsurancePayout - r.metrics.reinsurancePremiumOut;
    const cashNet = insuranceNet + reinsuranceNet;
    expect(cashNet).toBeLessThan(0);
  });

  it("is deterministic given the same seed", () => {
    const a = runStressSession({ scenario: SCENARIOS.SINGLE_EVENT, seed: 7 });
    const b = runStressSession({ scenario: SCENARIOS.SINGLE_EVENT, seed: 7 });
    expect(a.jointOutcomeFraction).toBe(b.jointOutcomeFraction);
    expect(a.finalWealth).toBe(b.finalWealth);
  });

  it("different seeds produce different sample paths", () => {
    const a = runStressSession({
      scenario: SCENARIOS.CORRELATED_CRISIS,
      seed: 1,
    });
    const b = runStressSession({
      scenario: SCENARIOS.CORRELATED_CRISIS,
      seed: 2,
    });
    // It's vanishingly unlikely they produce identical outcomes given
    // independent RNG streams across 200 ticks of trigger-roll.
    // (If they're equal, the RNG is probably broken.)
    const looksDifferent =
      a.jointOutcomeFraction !== b.jointOutcomeFraction ||
      a.metrics.triggerCount !== b.metrics.triggerCount;
    expect(looksDifferent).toBe(true);
  });

  it("metrics fields are present and numeric", () => {
    const r = runStressSession({ scenario: SCENARIOS.SINGLE_EVENT, seed: 3 });
    for (const key of [
      "tbillEarned",
      "threadPrincipalGain",
      "premiumIn",
      "premiumOut",
      "claimIn",
      "claimOut",
      "reinsurancePayout",
      "threadDamageApplied",
      "finalThreadPrincipal",
      "expressPenalty",
      "triggerCount",
    ]) {
      expect(Number.isFinite(r.metrics[key])).toBe(true);
    }
  });

  it("REDEMPTION_PRESSURE scenario performs partial redemptions over time", () => {
    const r = runStressSession({
      scenario: SCENARIOS.REDEMPTION_PRESSURE,
      seed: 11,
    });
    // Redemption pressure means the cycle ran multiple times during
    // the session; some dollars were drained mid-run rather than only
    // in the final-redemption phase.
    expect(r.metrics.redemptionDollars).toBeGreaterThan(0);
  });
});

describe("runStressBatch", () => {
  it("returns aggregate stats including pPositive headline", () => {
    const agg = runStressBatch({
      scenario: SCENARIOS.CALM,
      n: 30,
      seedBase: 100,
    });
    expect(agg.n).toBe(30);
    expect(agg.scenarioId).toBe("CALM");
    expect(agg.headline.pPositive).toBeGreaterThanOrEqual(0);
    expect(agg.headline.pPositive).toBeLessThanOrEqual(1);
    expect(agg.headline.pNegative).toBeGreaterThanOrEqual(0);
    expect(
      Math.abs(agg.headline.pPositive + agg.headline.pNegative - 1)
    ).toBeLessThan(1e-9);
  });

  it("distribution percentiles are monotonic", () => {
    const agg = runStressBatch({
      scenario: SCENARIOS.SINGLE_EVENT,
      n: 50,
      seedBase: 200,
    });
    const d = agg.distribution.fraction;
    expect(d.worst).toBeLessThanOrEqual(d.p05);
    expect(d.p05).toBeLessThanOrEqual(d.p25);
    expect(d.p25).toBeLessThanOrEqual(d.p50);
    expect(d.p50).toBeLessThanOrEqual(d.p75);
    expect(d.p75).toBeLessThanOrEqual(d.p95);
    expect(d.p95).toBeLessThanOrEqual(d.best);
  });

  it("CALM has higher P(positive) than CORRELATED_CRISIS at same N", () => {
    const calm = runStressBatch({
      scenario: SCENARIOS.CALM,
      n: 50,
      seedBase: 300,
    });
    const crisis = runStressBatch({
      scenario: SCENARIOS.CORRELATED_CRISIS,
      n: 50,
      seedBase: 300,
    });
    // Crisis triggers events that damage threads — at least as risky
    // as calm, almost always strictly more.
    expect(calm.headline.pPositive).toBeGreaterThanOrEqual(
      crisis.headline.pPositive
    );
  });
});
