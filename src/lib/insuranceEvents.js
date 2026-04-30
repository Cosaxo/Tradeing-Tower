// Insurance event registry + detection.
//
// Insurance markets pay out when specific protocol-defined events trigger.
// This module defines the standard event set and provides a per-tick
// detector that scans the simulator state and reports which events
// fired.
//
// Two event categories:
//
//   Per-pair price events: scoped to a single asset (e.g. "BTC drops
//   >20% within a week"). Detection windows the pair's recent prices.
//
//   Macro events: cross-cutting structural conditions (e.g. "≥3 pairs
//   in CRASH regime simultaneously", "system-solvency-buffer < 5%").
//   Detection looks at the global pairStates snapshot.
//
// External-facing strings use real-world time language ("a week", "two
// weeks"). Internally we translate via EPOCH_DAYS — one medium epoch
// is ~one trading day in this sim's economic clock.

import { ACTIVE_PAIRS, PAIRS } from "../constants/assets.js";

// One medium tick ≈ one trading day. Use these to translate user-facing
// "a week" / "two weeks" into epoch windows for detection.
export const EPOCH_DAYS = 1;
export const DAYS_PER_WEEK = 7;
const W = (n) => Math.round(n * DAYS_PER_WEEK / EPOCH_DAYS);

// ---------------------------------------------------------------------------
// Standard event registry
// ---------------------------------------------------------------------------
//
// Each event defines:
//   id            — stable identifier
//   label         — user-facing name (no "epochs" — real-world phrasing)
//   category      — "pair-price" | "macro"
//   pairKey?      — for pair-price events
//   detect(ctx)   — pure function returning true/false given context
//
// Context shape per detect call:
//   { pairStates, regimeMap, solvencyBuffer, correlationMap, currentEpoch }

export const STANDARD_EVENTS = [
  // ---- Per-pair price events --------------------------------------------
  {
    id: "BTC_CRASH_20_WEEK",
    label: "BTC falls >20% in a week",
    category: "pair-price",
    pairKey: "BTCUSD",
    detect: (ctx) => priceMoveExceeds(ctx, "BTCUSD", -0.20, W(1)),
  },
  {
    id: "ETH_CRASH_25_WEEK",
    label: "ETH falls >25% in a week",
    category: "pair-price",
    pairKey: "ETHUSD",
    detect: (ctx) => priceMoveExceeds(ctx, "ETHUSD", -0.25, W(1)),
  },
  {
    id: "SPX_CRASH_10_2WEEK",
    label: "SPX500 falls >10% in two weeks",
    category: "pair-price",
    pairKey: "SPX500",
    detect: (ctx) => priceMoveExceeds(ctx, "SPX500", -0.10, W(2)),
  },
  {
    id: "GOLD_RALLY_15_WEEK",
    label: "GOLD rallies >15% in a week",
    category: "pair-price",
    pairKey: "GOLD",
    detect: (ctx) => priceMoveExceeds(ctx, "GOLD", +0.15, W(1)),
  },

  // ---- Macro events -----------------------------------------------------
  {
    id: "VOL_SPIKE",
    label: "Volatility spike on a major index (realised σ > 0.08)",
    category: "macro",
    detect: (ctx) =>
      Object.values(ctx.pairStates ?? {}).some(
        (ps) =>
          ps?.pair?.assetClass === "INDEX_MAJOR" &&
          (ps?.realizedSigma ?? 0) > 0.08
      ),
  },
  {
    id: "MULTI_CRASH",
    label: "Three or more pairs in CRASH regime simultaneously",
    category: "macro",
    detect: (ctx) => {
      const crashCount = Object.values(ctx.pairStates ?? {}).filter(
        (ps) => ps?.regime?.key === "CRASH"
      ).length;
      return crashCount >= 3;
    },
  },
  {
    id: "SOLVENCY_LOW",
    label: "System solvency buffer falls below 5%",
    category: "macro",
    detect: (ctx) => (ctx.solvencyBuffer ?? 1) < 0.05,
  },
  {
    id: "CORRELATION_SHOCK",
    label: "Cross-pair correlation shock (mean |ρ| > 0.85)",
    category: "macro",
    detect: (ctx) => avgAbsCorrelation(ctx.correlationMap) > 0.85,
  },
];

// ---------------------------------------------------------------------------
// Helpers used by detectors
// ---------------------------------------------------------------------------

// Check whether `pairKey`'s price moved by `requiredPct` (signed) over
// the last `windowEpochs` epochs. Returns false when not enough history.
function priceMoveExceeds(ctx, pairKey, requiredPct, windowEpochs) {
  const ps = ctx.pairStates?.[pairKey];
  if (!ps) return false;
  const prices = ps.prices ?? [];
  if (prices.length < windowEpochs + 1) return false;
  const start = prices[prices.length - 1 - windowEpochs];
  const end = prices[prices.length - 1];
  if (!Number.isFinite(start) || start <= 0) return false;
  const move = (end - start) / start;
  return requiredPct < 0 ? move <= requiredPct : move >= requiredPct;
}

// Mean absolute pairwise correlation across the cross-pair correlation map.
// `correlationMap` shape: { [pairKey]: { [otherPairKey]: number } }
function avgAbsCorrelation(correlationMap) {
  if (!correlationMap) return 0;
  const values = [];
  for (const a of Object.keys(correlationMap)) {
    for (const b of Object.keys(correlationMap[a] ?? {})) {
      if (a === b) continue;
      const rho = correlationMap[a][b];
      if (Number.isFinite(rho)) values.push(Math.abs(rho));
    }
  }
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Get the registry. Custom event sets can be supplied where needed; the
// standard list is the default.
export function getEventRegistry() {
  return STANDARD_EVENTS;
}

export function findEvent(eventId, registry = STANDARD_EVENTS) {
  return registry.find((e) => e.id === eventId) ?? null;
}

// Run all detectors against the current context. Returns the list of
// triggered event IDs. Pure: same context → same result.
export function detectTriggeredEvents(ctx, registry = STANDARD_EVENTS) {
  const triggered = [];
  for (const ev of registry) {
    try {
      if (ev.detect(ctx)) triggered.push(ev.id);
    } catch {
      // Defensive: a malformed detector shouldn't crash the loop.
    }
  }
  return triggered;
}

// IDs grouped by category for UI display.
export function eventsByCategory(registry = STANDARD_EVENTS) {
  const out = { "pair-price": [], macro: [] };
  for (const ev of registry) {
    out[ev.category] = out[ev.category] ?? [];
    out[ev.category].push(ev);
  }
  return out;
}

// Sanity helper: every active pair should have at least one event so
// markets exist for it. Returns IDs of pairs without any pair-price event.
export function pairsWithoutEvents(registry = STANDARD_EVENTS) {
  const covered = new Set(
    registry.filter((e) => e.category === "pair-price").map((e) => e.pairKey)
  );
  return ACTIVE_PAIRS.filter((pk) => !covered.has(pk) && PAIRS[pk]);
}
