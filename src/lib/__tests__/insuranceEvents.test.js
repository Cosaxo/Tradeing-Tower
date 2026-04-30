import { describe, it, expect } from "vitest";
import {
  STANDARD_EVENTS,
  detectTriggeredEvents,
  findEvent,
  eventsByCategory,
} from "../insuranceEvents.js";

function pairWithPrices(pairKey, prices, extras = {}) {
  return {
    pair: { assetClass: extras.assetClass ?? "CRYPTO" },
    prices,
    realizedSigma: extras.realizedSigma ?? 0.02,
    regime: extras.regime ?? { key: "CALM" },
  };
}

describe("STANDARD_EVENTS", () => {
  it("includes both pair-price and macro events", () => {
    const cats = eventsByCategory();
    expect(cats["pair-price"].length).toBeGreaterThan(0);
    expect(cats["macro"].length).toBeGreaterThan(0);
  });

  it("each event has a unique id", () => {
    const ids = STANDARD_EVENTS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("findEvent returns null for unknown id", () => {
    expect(findEvent("NOPE")).toBeNull();
    expect(findEvent("BTC_CRASH_20_WEEK")?.label).toMatch(/BTC/);
  });
});

describe("detectTriggeredEvents — pair-price events", () => {
  it("BTC -20% over a week triggers BTC_CRASH_20_WEEK", () => {
    const start = 50000;
    // 8 prices: index 7 (last) is the current; index 7-7=0 is one week ago.
    const prices = [start, start, start, start, start, start, start, start * 0.79];
    const ctx = { pairStates: { BTCUSD: pairWithPrices("BTCUSD", prices) } };
    const triggered = detectTriggeredEvents(ctx);
    expect(triggered).toContain("BTC_CRASH_20_WEEK");
  });

  it("BTC -10% does NOT trigger BTC_CRASH_20_WEEK", () => {
    const start = 50000;
    const prices = [start, start, start, start, start, start, start, start * 0.91];
    const ctx = { pairStates: { BTCUSD: pairWithPrices("BTCUSD", prices) } };
    expect(detectTriggeredEvents(ctx)).not.toContain("BTC_CRASH_20_WEEK");
  });

  it("GOLD +15% over a week triggers GOLD_RALLY_15_WEEK", () => {
    const start = 2000;
    const prices = [start, start, start, start, start, start, start, start * 1.16];
    const ctx = { pairStates: { GOLD: pairWithPrices("GOLD", prices, { assetClass: "GOLD" }) } };
    expect(detectTriggeredEvents(ctx)).toContain("GOLD_RALLY_15_WEEK");
  });

  it("not enough price history → no false positive", () => {
    const ctx = { pairStates: { BTCUSD: pairWithPrices("BTCUSD", [50000, 30000]) } };
    expect(detectTriggeredEvents(ctx)).not.toContain("BTC_CRASH_20_WEEK");
  });
});

describe("detectTriggeredEvents — macro events", () => {
  it("VOL_SPIKE triggers when an INDEX_MAJOR pair has realized σ > 0.08", () => {
    const ctx = {
      pairStates: {
        SPX500: pairWithPrices("SPX500", [], {
          assetClass: "INDEX_MAJOR",
          realizedSigma: 0.10,
        }),
      },
    };
    expect(detectTriggeredEvents(ctx)).toContain("VOL_SPIKE");
  });

  it("VOL_SPIKE does not trigger on σ < threshold", () => {
    const ctx = {
      pairStates: {
        SPX500: pairWithPrices("SPX500", [], {
          assetClass: "INDEX_MAJOR",
          realizedSigma: 0.05,
        }),
      },
    };
    expect(detectTriggeredEvents(ctx)).not.toContain("VOL_SPIKE");
  });

  it("MULTI_CRASH triggers when ≥3 pairs in CRASH regime", () => {
    const ctx = {
      pairStates: {
        A: pairWithPrices("A", [], { regime: { key: "CRASH" } }),
        B: pairWithPrices("B", [], { regime: { key: "CRASH" } }),
        C: pairWithPrices("C", [], { regime: { key: "CRASH" } }),
        D: pairWithPrices("D", [], { regime: { key: "CALM" } }),
      },
    };
    expect(detectTriggeredEvents(ctx)).toContain("MULTI_CRASH");
  });

  it("MULTI_CRASH does NOT trigger with only 2 in CRASH", () => {
    const ctx = {
      pairStates: {
        A: pairWithPrices("A", [], { regime: { key: "CRASH" } }),
        B: pairWithPrices("B", [], { regime: { key: "CRASH" } }),
        C: pairWithPrices("C", [], { regime: { key: "CALM" } }),
      },
    };
    expect(detectTriggeredEvents(ctx)).not.toContain("MULTI_CRASH");
  });

  it("SOLVENCY_LOW fires when buffer < 5%", () => {
    expect(detectTriggeredEvents({ solvencyBuffer: 0.04 })).toContain("SOLVENCY_LOW");
    expect(detectTriggeredEvents({ solvencyBuffer: 0.5 })).not.toContain("SOLVENCY_LOW");
  });

  it("CORRELATION_SHOCK fires when mean |ρ| > 0.85", () => {
    const corr = {
      A: { B: 0.95, C: 0.9 },
      B: { A: 0.95, C: 0.88 },
      C: { A: 0.9, B: 0.88 },
    };
    expect(detectTriggeredEvents({ correlationMap: corr })).toContain("CORRELATION_SHOCK");
  });

  it("CORRELATION_SHOCK does not trigger on weak correlations", () => {
    const corr = { A: { B: 0.2 }, B: { A: 0.2 } };
    expect(detectTriggeredEvents({ correlationMap: corr })).not.toContain(
      "CORRELATION_SHOCK"
    );
  });
});

describe("detectTriggeredEvents — defensive", () => {
  it("a throwing detector doesn't break others", () => {
    const broken = [
      { id: "BREAKS", category: "macro", detect: () => { throw new Error("boom"); } },
      { id: "OK", category: "macro", detect: () => true },
    ];
    expect(detectTriggeredEvents({}, broken)).toEqual(["OK"]);
  });

  it("empty context yields no triggers", () => {
    expect(detectTriggeredEvents({})).toEqual([]);
  });
});
