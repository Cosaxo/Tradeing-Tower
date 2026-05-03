// StressHarnessPanel — runs the Monte Carlo stress harness in-browser
// and surfaces the joint-outcome distribution as the headline safety
// metric.
//
// One button per scenario. Each click runs N seeded sessions
// synchronously (the harness is fast enough — typically <2s for n=200
// per scenario) and renders an aggregate report inline.

import { useState } from "react";
import { SCENARIOS, runStressBatch } from "../lib/stressHarness.js";

const SCENARIO_LIST = Object.values(SCENARIOS);
const DEFAULT_N = 200;

function pct(x, digits = 1) {
  if (!Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}
function dol(x) {
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "";
  return `${sign}$${Math.abs(x).toFixed(0)}`;
}

function pPositiveColor(p) {
  if (p >= 0.95) return "#34d399"; // emerald — safe claim met
  if (p >= 0.75) return "#fbbf24"; // amber — borderline
  return "#f87171"; // red — claim violated
}

// Tiny inline histogram of the fraction distribution. Buckets the
// raw fractions into 12 cells from p05 to p95.
function HistogramBar({ fractions }) {
  if (!fractions || fractions.length === 0) return null;
  const sorted = [...fractions].sort((a, b) => a - b);
  const lo = sorted[Math.floor(sorted.length * 0.05)];
  const hi = sorted[Math.floor(sorted.length * 0.95)];
  const span = Math.max(1e-6, hi - lo);
  const bucketCount = 14;
  const buckets = new Array(bucketCount).fill(0);
  for (const f of sorted) {
    const t = (f - lo) / span;
    const idx = Math.max(0, Math.min(bucketCount - 1, Math.floor(t * bucketCount)));
    buckets[idx] += 1;
  }
  const maxBucket = Math.max(1, ...buckets);
  return (
    <div className="flex items-end gap-px h-8">
      {buckets.map((c, i) => {
        const h = (c / maxBucket) * 100;
        const t = (i + 0.5) / bucketCount;
        const value = lo + t * span;
        const color = value >= 0 ? "#34d399" : "#f87171";
        return (
          <div
            key={i}
            className="flex-1 rounded-sm"
            style={{ height: `${h}%`, background: color, minHeight: "1px" }}
            title={`${pct(value, 1)}`}
          />
        );
      })}
    </div>
  );
}

function ScenarioResult({ agg }) {
  const c = pPositiveColor(agg.headline.pPositive);
  const f = agg.distribution.fraction;
  const l = agg.perLayerMean;

  return (
    <div className="rounded border border-gray-800 bg-gray-950/40 p-3 flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-mono text-gray-200 font-bold">
          {agg.scenarioName}
        </span>
        <span className="text-[10px] font-mono text-gray-500">
          n = {agg.n} · ${agg.initialDeposit} initial
        </span>
      </div>

      {/* Headline P(positive) */}
      <div className="flex items-center gap-3 py-1">
        <div className="flex flex-col">
          <span className="text-[10px] font-mono text-gray-500 uppercase">
            P(joint outcome ≥ 0)
          </span>
          <span
            className="text-2xl font-mono font-bold"
            style={{ color: c }}
          >
            {pct(agg.headline.pPositive)}
          </span>
        </div>
        <div className="flex flex-col text-[10px] font-mono text-gray-400 leading-tight">
          <span>
            P(≥ +5%) <span className="text-gray-200">{pct(agg.headline.pBeats5pct)}</span>
          </span>
          <span>
            mean outcome <span className="text-gray-200">{pct(agg.headline.meanFraction)}</span>
          </span>
          <span>
            mean annualised <span className="text-gray-200">{pct(agg.headline.meanAnnualised)}</span>
          </span>
        </div>
      </div>

      {/* Distribution histogram */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-gray-500 uppercase">
          fraction distribution (p05 → p95)
        </span>
        <HistogramBar fractions={agg.rawFractions} />
        <div className="flex justify-between text-[9px] font-mono text-gray-500">
          <span>worst {pct(f.worst)}</span>
          <span>p25 {pct(f.p25)}</span>
          <span>p50 {pct(f.p50)}</span>
          <span>p75 {pct(f.p75)}</span>
          <span>best {pct(f.best)}</span>
        </div>
      </div>

      {/* Per-layer flow */}
      <div className="flex flex-col gap-0.5 pt-1 border-t border-gray-800">
        <span className="text-[10px] font-mono text-gray-500 uppercase">
          per-layer mean ($)
        </span>
        <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] font-mono">
          <Row label="T-bill earned" value={l.tbillEarned} />
          <Row label="insurance premium net" value={l.insurancePremiumNet} />
          <Row label="insurance claim net" value={l.claimNet} />
          <Row label="reinsurance net" value={l.reinsuranceNet} />
          <Row label="thread damage" value={-l.threadDamageApplied} />
          <Row label="soft debt" value={-l.debtRemaining} />
        </div>
      </div>

      <div className="text-[10px] font-mono text-gray-500">
        {agg.triggerCountMean.toFixed(1)} event triggers / run on average
      </div>
    </div>
  );
}

function Row({ label, value }) {
  const color = value >= 0 ? "text-emerald-300" : "text-rose-300";
  return (
    <div className="flex justify-between gap-2">
      <span className="text-gray-400">{label}</span>
      <span className={color}>{dol(value)}</span>
    </div>
  );
}

export function StressHarnessPanel() {
  const [results, setResults] = useState({}); // { [scenarioId]: agg }
  const [running, setRunning] = useState(null); // currently-running scenarioId
  const [n, setN] = useState(DEFAULT_N);

  function runOne(scenario) {
    setRunning(scenario.id);
    // Defer to the next frame so the running indicator paints.
    setTimeout(() => {
      try {
        const agg = runStressBatch({ scenario, n });
        setResults((prev) => ({ ...prev, [scenario.id]: agg }));
      } finally {
        setRunning(null);
      }
    }, 0);
  }

  function runAll() {
    setRunning("ALL");
    setTimeout(() => {
      try {
        const next = {};
        for (const sc of SCENARIO_LIST) {
          next[sc.id] = runStressBatch({ scenario: sc, n });
        }
        setResults(next);
      } finally {
        setRunning(null);
      }
    }, 0);
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="rounded border border-indigo-800 bg-indigo-950/30 p-3 flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-mono text-indigo-200 font-bold">
            Monte Carlo stress harness
          </span>
          <span className="text-[10px] font-mono text-gray-500">
            empirical evidence for the joint-outcome safety claim
          </span>
        </div>
        <p className="text-[10px] font-mono text-gray-400 leading-tight">
          Each run drives a single user through the auto-mint flow
          (allocate → buy reinsurance → mint TT) and applies a stress
          scenario for 200 medium epochs. Joint outcome = (final cash
          margin + redeemable thread principal) − initial deposit.
          The headline metric P(joint outcome ≥ 0) tells you whether
          the protocol delivers on its core safety claim under
          realistic stress.
        </p>
        <div className="flex items-center gap-2 mt-1">
          <label className="text-[10px] font-mono text-gray-400">
            n per scenario
          </label>
          <select
            value={n}
            onChange={(e) => setN(parseInt(e.target.value, 10))}
            disabled={running != null}
            className="bg-gray-900 border border-gray-700 rounded text-[10px] font-mono text-gray-200 px-1 py-0.5"
          >
            <option value={50}>50</option>
            <option value={100}>100</option>
            <option value={200}>200</option>
            <option value={500}>500</option>
            <option value={1000}>1000</option>
          </select>
          <button
            onClick={runAll}
            disabled={running != null}
            className={`text-[11px] font-mono px-3 py-1 rounded border ${
              running == null
                ? "border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900"
                : "border-gray-800 bg-gray-900 text-gray-600 cursor-not-allowed"
            }`}
          >
            {running === "ALL" ? "running…" : "Run all scenarios"}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        {SCENARIO_LIST.map((sc) => {
          const agg = results[sc.id];
          const isRunning = running === sc.id;
          return (
            <div key={sc.id} className="flex flex-col gap-1">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] font-mono text-gray-300">
                  {sc.name}
                </span>
                <button
                  onClick={() => runOne(sc)}
                  disabled={running != null}
                  className={`text-[10px] font-mono px-2 py-0.5 rounded border ${
                    running == null
                      ? "border-gray-700 bg-gray-900 text-gray-300 hover:bg-gray-800"
                      : "border-gray-800 bg-gray-900 text-gray-600 cursor-not-allowed"
                  }`}
                >
                  {isRunning ? "running…" : "run"}
                </button>
              </div>
              <p className="text-[10px] font-mono text-gray-500 leading-tight">
                {sc.description}
              </p>
              {agg && <ScenarioResult agg={agg} />}
            </div>
          );
        })}
      </div>

      <div className="rounded border border-amber-800 bg-amber-950/30 p-3">
        <span className="text-xs font-mono text-amber-200 font-bold block mb-1">
          Known calibration findings (surfaced by the harness)
        </span>
        <ul className="text-[10px] font-mono text-gray-300 list-disc pl-4 space-y-1 leading-relaxed">
          <li>
            <span className="text-amber-300">REINSURANCE_BASE_RATE = 0.010</span>{" "}
            (per medium tick) is ~365% annualised. The reinsurance premium
            cost dominates every scenario, including CALM. Joint outcome
            stays negative in default config.
          </li>
          <li>
            <span className="text-amber-300">TBILL_RATE = 0.001</span>{" "}
            (annual) is effectively zero. Layer 1's contribution to joint
            outcome is negligible. Protocol's safety claim depends on this
            being a meaningful positive yield.
          </li>
          <li>
            Auto-mint reinsurance face = 1.5× principal. With coverage
            fractions summing to 1.0 this gives effective coverage of
            ~50% of insurer-side exposure. Worth re-tuning relative to
            the premium-rate calibration.
          </li>
        </ul>
        <p className="text-[10px] font-mono text-gray-400 mt-2 leading-relaxed">
          These are protocol-calibration tasks for a future sprint. The
          harness's value is producing this evidence, not asserting that
          the safety claim is currently met — it isn't, in default config.
        </p>
      </div>
    </div>
  );
}
