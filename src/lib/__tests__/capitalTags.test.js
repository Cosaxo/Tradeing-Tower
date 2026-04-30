import { describe, it, expect } from "vitest";
import {
  TAG_KEYS,
  initTags,
  totalTagged,
  freeMargin,
  tryTag,
  untag,
  normalizeTags,
} from "../capitalTags.js";

describe("initTags", () => {
  it("starts with zero on every role", () => {
    const t = initTags();
    for (const k of TAG_KEYS) expect(t[k]).toBe(0);
  });
});

describe("totalTagged", () => {
  it("returns 0 for null/empty", () => {
    expect(totalTagged(null)).toBe(0);
    expect(totalTagged({})).toBe(0);
  });
  it("sums all tag slots", () => {
    const t = { poolDeposit: 100, auctionMargin: 200, contractCollateral: 50 };
    expect(totalTagged(t)).toBe(350);
  });
});

describe("freeMargin", () => {
  it("is margin when nothing tagged", () => {
    expect(freeMargin(5000, initTags())).toBe(5000);
  });
  it("subtracts total tags", () => {
    const t = { ...initTags(), poolDeposit: 1000, auctionMargin: 500 };
    expect(freeMargin(5000, t)).toBe(3500);
  });
  it("clamps at 0 when over-tagged", () => {
    const t = { ...initTags(), poolDeposit: 6000 };
    expect(freeMargin(5000, t)).toBe(0);
  });
});

describe("tryTag", () => {
  it("adds when free margin sufficient", () => {
    const t = tryTag(5000, initTags(), "poolDeposit", 1000);
    expect(t.poolDeposit).toBe(1000);
  });
  it("stacks tags on the same margin (§10.1 core invariant)", () => {
    let t = initTags();
    t = tryTag(5000, t, "poolDeposit", 2000);
    t = tryTag(5000, t, "auctionMargin", 2000);
    t = tryTag(5000, t, "contractCollateral", 1000);
    expect(totalTagged(t)).toBe(5000);
    expect(freeMargin(5000, t)).toBe(0);
  });
  it("returns null when over-tagging would exceed margin", () => {
    const t = { ...initTags(), poolDeposit: 4500 };
    expect(tryTag(5000, t, "auctionMargin", 1000)).toBeNull();
  });
  it("untagging is always allowed", () => {
    const t = { ...initTags(), poolDeposit: 1000 };
    const r = tryTag(100, t, "poolDeposit", -500);
    expect(r.poolDeposit).toBe(500);
  });
});

describe("untag", () => {
  it("reduces toward zero", () => {
    const t = { ...initTags(), poolDeposit: 1000 };
    expect(untag(t, "poolDeposit", 400).poolDeposit).toBe(600);
  });
  it("never goes negative", () => {
    const t = { ...initTags(), poolDeposit: 100 };
    expect(untag(t, "poolDeposit", 999).poolDeposit).toBe(0);
  });
});

describe("normalizeTags", () => {
  it("leaves tags unchanged when margin exceeds total tagged", () => {
    const t = { ...initTags(), poolDeposit: 1000, auctionMargin: 2000 };
    const r = normalizeTags(5000, t);
    expect(r.poolDeposit).toBe(1000);
    expect(r.auctionMargin).toBe(2000);
  });
  it("scales tags proportionally when margin falls below total", () => {
    const t = { ...initTags(), poolDeposit: 1000, auctionMargin: 1000 };
    const r = normalizeTags(1000, t);
    expect(r.poolDeposit).toBeCloseTo(500);
    expect(r.auctionMargin).toBeCloseTo(500);
    expect(totalTagged(r)).toBeCloseTo(1000);
  });
  it("handles zero margin without divide-by-zero", () => {
    const t = { ...initTags(), poolDeposit: 1000 };
    const r = normalizeTags(0, t);
    expect(totalTagged(r)).toBeCloseTo(0);
  });
});
