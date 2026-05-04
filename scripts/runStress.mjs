#!/usr/bin/env node
//
// CLI for the stress harness. Runs a Monte Carlo batch of one or
// more scenarios and prints the aggregate report to stdout.
//
// Usage:
//   node scripts/runStress.mjs                # all scenarios, n=200
//   node scripts/runStress.mjs --n 1000       # 1000 runs per scenario
//   node scripts/runStress.mjs --scenario CALM
//
// The headline metric is P(joint outcome ≥ 0) across the batch —
// the empirical evidence for the protocol's safety claim.

import {
  SCENARIOS,
  runStressBatch,
} from "../src/lib/stressHarness.js";

// ---------------------------------------------------------------------------
// Argv parsing — minimal, no deps.
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
let n = 200;
let scenarioId = null;
let initialDeposit = 10000;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--n") n = parseInt(argv[++i], 10);
  else if (a === "--scenario") scenarioId = argv[++i];
  else if (a === "--deposit") initialDeposit = parseFloat(argv[++i]);
  else if (a === "--help" || a === "-h") {
    console.log(`usage: runStress.mjs [--n 200] [--scenario CALM|SINGLE_EVENT|...] [--deposit 10000]`);
    process.exit(0);
  }
}

// ---------------------------------------------------------------------------
// Print a single batch result.
// ---------------------------------------------------------------------------

function pct(x) {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(1)}%`;
}
function dol(x) {
  if (!Number.isFinite(x)) return "—";
  return `$${x.toFixed(2)}`;
}

function printBatch(agg) {
  console.log("");
  console.log(`──── ${agg.scenarioId}  (${agg.scenarioName}) ────`);
  console.log(`  n = ${agg.n}    initial deposit = $${agg.initialDeposit}`);
  console.log("");
  console.log(`  P(joint outcome ≥ 0)        ${pct(agg.headline.pPositive)}`);
  console.log(`  P(joint outcome ≥ +5%)      ${pct(agg.headline.pBeats5pct)}`);
  console.log(`  P(joint outcome <  0)       ${pct(agg.headline.pNegative)}`);
  console.log("");
  console.log(`  mean joint outcome          ${pct(agg.headline.meanFraction)}`);
  console.log(`  mean annualised yield       ${pct(agg.headline.meanAnnualised)}`);
  console.log("");
  console.log("  fraction distribution:");
  const f = agg.distribution.fraction;
  console.log(`    worst   ${pct(f.worst).padStart(8)}`);
  console.log(`    p05     ${pct(f.p05).padStart(8)}`);
  console.log(`    p25     ${pct(f.p25).padStart(8)}`);
  console.log(`    p50     ${pct(f.p50).padStart(8)}`);
  console.log(`    p75     ${pct(f.p75).padStart(8)}`);
  console.log(`    p95     ${pct(f.p95).padStart(8)}`);
  console.log(`    best    ${pct(f.best).padStart(8)}`);
  console.log("");
  console.log("  per-layer mean ($):");
  const l = agg.perLayerMean;
  console.log(`    T-bill earned             ${dol(l.tbillEarned)}`);
  console.log(`    insurance premium net     ${dol(l.insurancePremiumNet)}`);
  console.log(`    insurance claim net       ${dol(l.claimNet)}`);
  console.log(`    reinsurance net           ${dol(l.reinsuranceNet)}`);
  console.log(`    thread damage applied     ${dol(l.threadDamageApplied)}`);
  console.log(`    final thread principal    ${dol(l.finalRedemption ?? 0)}`);
  console.log(`    soft debt remaining       ${dol(l.debtRemaining)}`);
  console.log("");
  console.log(`  triggers / run (mean)       ${agg.triggerCountMean.toFixed(2)}`);
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

const scenarios = scenarioId
  ? [SCENARIOS[scenarioId]].filter(Boolean)
  : Object.values(SCENARIOS);

if (scenarios.length === 0) {
  console.error(`Unknown scenario: ${scenarioId}`);
  console.error(`Available: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
}

console.log("Trading Tower — stress harness");
console.log(`Running ${scenarios.length} scenario(s) × n=${n}`);

const t0 = Date.now();
for (const sc of scenarios) {
  const agg = runStressBatch({ scenario: sc, n, initialDeposit });
  printBatch(agg);
}
const dt = Date.now() - t0;

console.log("");
console.log(`Completed in ${dt}ms (${(dt / scenarios.length).toFixed(0)}ms / scenario, ${(dt / (scenarios.length * n)).toFixed(2)}ms / session)`);
