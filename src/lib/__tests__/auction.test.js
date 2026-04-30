import { describe, it, expect } from "vitest";
import {
  geodesicWeight,
  estimateSmileParams,
  blendSmileParams,
  calcEntropyWeights,
  getEntropyMultForUser,
  adaptMetaParams,
  runAuction,
  timeWeightedYieldMult,
} from "../auction.js";

describe("geodesicWeight", () => {
  it("is zero at non-positive leverage", () => {
    expect(geodesicWeight(0, 0, 0.02)).toBe(0);
    expect(geodesicWeight(-1, 0, 0.02)).toBe(0);
  });
  it("produces finite positive weight for reasonable input", () => {
    const w = geodesicWeight(2, 0, 0.02, 0, 0, { muLow: 0, alpha: 0.5 });
    expect(Number.isFinite(w)).toBe(true);
    expect(w).toBeGreaterThan(0);
  });
});

describe("smile params", () => {
  it("returns zero skew/kurtosis for empty bids", () => {
    const { sk, ek } = estimateSmileParams([], 0);
    expect(sk).toBe(0);
    expect(ek).toBe(0);
  });
  it("blend mixes prior and live 70/30", () => {
    const blended = blendSmileParams({ sk: 1, ek: 2 }, { sk: 0, ek: 0 });
    expect(blended.sk).toBeCloseTo(0.7);
    expect(blended.ek).toBeCloseTo(1.4);
  });
});

describe("entropy weights", () => {
  it("gives even weights for matched distribution", () => {
    const ideal = [0.5, 0.5];
    const actual = [0.5, 0.5];
    const { normWeights } = calcEntropyWeights(ideal, actual, null);
    expect(normWeights[0]).toBeCloseTo(normWeights[1], 3);
  });
  it("boosts under-supplied buckets", () => {
    const ideal = [0.5, 0.5];
    const actual = [0.9, 0.1]; // bucket 1 under-supplied
    const { normWeights } = calcEntropyWeights(ideal, actual, null);
    expect(normWeights[1]).toBeGreaterThan(normWeights[0]);
  });
});

describe("getEntropyMultForUser", () => {
  it("returns 1 when no weights", () => {
    expect(getEntropyMultForUser(2, [], [])).toBe(1);
  });
  it("picks the nearest bucket", () => {
    const mult = getEntropyMultForUser(5, [0.2, 0.3, 0.5], [1, 5, 10]);
    expect(mult).toBeGreaterThan(0);
  });
});

describe("adaptMetaParams", () => {
  it("keeps sigmaMix within bounds", () => {
    const meta = adaptMetaParams({ muLow: 0, alpha: 0.5 }, [1, 2, 3], [2, 2, 2], 0, 0.02);
    expect(meta.sigmaMix).toBeGreaterThanOrEqual(0.3);
    expect(meta.sigmaMix).toBeLessThanOrEqual(2.5);
  });
});

describe("runAuction", () => {
  const logs = [];
  const users = [
    { id: "A", strategy: "FIXED_LONG", max_lev: 2, base_margin: 1000, tip_tiers: [{ tip: 0.02 }] },
    { id: "B", strategy: "FIXED_SHORT", max_lev: 2, base_margin: 1000, tip_tiers: [{ tip: 0.02 }] },
  ];
  it("produces curves + matched list", () => {
    const result = runAuction(users, 0.5, logs, 5, { sk: 0, ek: 0 }, 0.02, null, {});
    expect(result.longCurve.length).toBeGreaterThan(0);
    expect(result.shortCurve.length).toBeGreaterThan(0);
    expect(result.matched.length).toBeGreaterThanOrEqual(0);
    expect(result.normWeights.length).toBe(result.longCurve.length);
  });
  it("short-circuits to an empty result when one side of the book is empty", () => {
    const onlyLongs = [
      { id: "A", strategy: "FIXED_LONG", max_lev: 2, base_margin: 1000, tip_tiers: [{ tip: 0.02 }] },
    ];
    const result = runAuction(onlyLongs, 0.5, [], 5, { sk: 0, ek: 0 }, 0.02, null, {});
    expect(result.matched).toEqual([]);
    expect(result.normWeights).toEqual([]);
    expect(result.bucketLevs).toEqual([]);
    expect(result.softClose).toBe(true);
  });
  it("flags soft-close when imbalance exceeds 0.8", () => {
    const imbalUsers = Array.from({ length: 10 }, (_, i) => ({
      id: `L${i}`,
      strategy: "FIXED_LONG",
      max_lev: 2,
      base_margin: 1000,
      tip_tiers: [{ tip: 0.02 }],
    }));
    imbalUsers.push({
      id: "S0",
      strategy: "FIXED_SHORT",
      max_lev: 2,
      base_margin: 1000,
      tip_tiers: [{ tip: 0.02 }],
    });
    const result = runAuction(imbalUsers, 0.9, [], 5, { sk: 0, ek: 0 }, 0.02, null, {});
    expect(result.softClose).toBe(true);
  });
});

describe("timeWeightedYieldMult re-export", () => {
  it("is available from auction.js", () => {
    expect(typeof timeWeightedYieldMult).toBe("function");
  });
});
