import { describe, it, expect } from "vitest";
import {
  initFloatsState,
  openThread,
  damageThread,
  growThread,
  calcInsuranceFillWeights,
  transferFloats,
  submitRedemption,
  cancelRedemption,
  runRedemptionCycle,
  applySolvencyCheck,
  totalSupply,
  totalCirculating,
  balanceOf,
  mintedByOf,
  debtOf,
  totalThreadPrincipal,
  activeThreads,
} from "../floats.js";
import { EXPRESS_PENALTY_RATE } from "../../constants/system.js";

// ---------------------------------------------------------------------------
// state factory + accessors
// ---------------------------------------------------------------------------

describe("initFloatsState", () => {
  it("starts empty", () => {
    const s = initFloatsState();
    expect(totalSupply(s)).toBe(0);
    expect(totalCirculating(s)).toBe(0);
    expect(s.threads).toEqual([]);
    expect(s.redemptionQueue).toEqual([]);
    expect(s.merchantBalance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fill weights
// ---------------------------------------------------------------------------

describe("calcInsuranceFillWeights", () => {
  it("equal-weights when reinsurance is empty", () => {
    const markets = [
      { eventId: "E1", insurerCapital: 0 },
      { eventId: "E2", insurerCapital: 0 },
      { eventId: "E3", insurerCapital: 0 },
    ];
    const w = calcInsuranceFillWeights({
      eligibleMarkets: markets,
      reinsuranceLive: false,
    });
    expect(w.E1).toBeCloseTo(1 / 3);
    expect(w.E2).toBeCloseTo(1 / 3);
    expect(w.E3).toBeCloseTo(1 / 3);
  });

  it("mixes equal floor with size proportional weighting", () => {
    const markets = [
      { eventId: "E1", insurerCapital: 1000 },
      { eventId: "E2", insurerCapital: 0 },
    ];
    const w = calcInsuranceFillWeights({
      eligibleMarkets: markets,
      reinsuranceLive: true,
    });
    // weight_i = 0.5 × 1/N + 0.5 × size_i/Σsize  (then renormalised)
    // raw = E1: 0.5×0.5 + 0.5×1 = 0.75; E2: 0.5×0.5 + 0.5×0 = 0.25
    expect(w.E1).toBeCloseTo(0.75);
    expect(w.E2).toBeCloseTo(0.25);
  });

  it("sums to 1 across eligible markets", () => {
    const markets = [
      { eventId: "E1", insurerCapital: 100 },
      { eventId: "E2", insurerCapital: 200 },
      { eventId: "E3", insurerCapital: 50 },
      { eventId: "E4", insurerCapital: 0 },
    ];
    const w = calcInsuranceFillWeights({
      eligibleMarkets: markets,
      reinsuranceLive: true,
    });
    const sum = Object.values(w).reduce((s, v) => s + v, 0);
    expect(sum).toBeCloseTo(1);
  });

  it("returns {} for an empty market list", () => {
    expect(
      calcInsuranceFillWeights({ eligibleMarkets: [], reinsuranceLive: true })
    ).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// openThread (mint)
// ---------------------------------------------------------------------------

describe("openThread", () => {
  const baseWeights = { E1: 0.5, E2: 0.5 };

  it("rejects non-positive principal", () => {
    expect(
      openThread({
        floatsState: initFloatsState(),
        ownerId: "A",
        principal: 0,
        insuranceWeights: baseWeights,
      }).ok
    ).toBe(false);
  });

  it("mints FLOAT 1:1 — principal === floatFace at open", () => {
    const r = openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: baseWeights,
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.floatsState, "A")).toBe(200);
    expect(mintedByOf(r.floatsState, "A")).toBe(200);
    expect(totalSupply(r.floatsState)).toBe(200);
    expect(r.thread.principal).toBe(200);
    expect(r.thread.floatFace).toBe(200);
  });

  it("does NOT impose any LTV gate or coefficient", () => {
    const r = openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 1000,
      insuranceWeights: { E1: 1 },
    });
    expect(r.ok).toBe(true);
    expect(r.thread.floatFace).toBe(1000);
  });

  it("appends to threads array", () => {
    let s = initFloatsState();
    s = openThread({
      floatsState: s,
      ownerId: "A",
      principal: 100,
      insuranceWeights: baseWeights,
    }).floatsState;
    s = openThread({
      floatsState: s,
      ownerId: "A",
      principal: 50,
      insuranceWeights: baseWeights,
    }).floatsState;
    expect(activeThreads(s)).toHaveLength(2);
    expect(totalThreadPrincipal(s, "A")).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// damageThread (loss propagation across all 4 layers)
// ---------------------------------------------------------------------------

describe("damageThread", () => {
  function seed(principal = 200) {
    return openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal,
      insuranceWeights: { E1: 0.6, E2: 0.4 },
    });
  }

  it("shrinks principal by the delta and reports per-layer deltas", () => {
    const { floatsState, thread } = seed(200);
    const r = damageThread({ floatsState, threadId: thread.id, delta: 50 });
    expect(r.deltaApplied).toBe(50);
    expect(r.poolLayerDelta).toBe(50);
    expect(r.insuranceLayerDeltas.E1).toBeCloseTo(50 * 0.6);
    expect(r.insuranceLayerDeltas.E2).toBeCloseTo(50 * 0.4);
    const updated = r.floatsState.threads[0];
    expect(updated.principal).toBe(150);
  });

  it("floatFace shrinks alongside principal when redemption hasn't occurred", () => {
    const { floatsState, thread } = seed(200);
    const r = damageThread({ floatsState, threadId: thread.id, delta: 50 });
    const updated = r.floatsState.threads[0];
    expect(updated.floatFace).toBe(150);
    expect(r.floatFaceDelta).toBe(50);
    expect(mintedByOf(r.floatsState, "A")).toBe(150);
  });

  it("caps damage at the thread's current principal", () => {
    const { floatsState, thread } = seed(100);
    const r = damageThread({ floatsState, threadId: thread.id, delta: 1e6 });
    expect(r.deltaApplied).toBe(100);
    expect(r.floatsState.threads[0].principal).toBe(0);
    expect(r.floatsState.threads[0].closed).toBe(true);
  });

  it("zero delta is a no-op", () => {
    const { floatsState, thread } = seed();
    const r = damageThread({ floatsState, threadId: thread.id, delta: 0 });
    expect(r.deltaApplied).toBe(0);
    expect(r.floatsState).toBe(floatsState);
  });

  it("propagates ALL FOUR layers symmetrically (the thread invariant)", () => {
    const { floatsState, thread } = seed(400);
    const r = damageThread({ floatsState, threadId: thread.id, delta: 100 });
    expect(r.deltaApplied).toBe(100);
    expect(r.poolLayerDelta).toBe(100); // B-book pool layer
    const insSum = Object.values(r.insuranceLayerDeltas).reduce((s, v) => s + v, 0);
    expect(insSum).toBeCloseTo(100);
    expect(r.floatFaceDelta).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// growThread (gain into layers 1, 2, 3 — NOT layer 4)
// ---------------------------------------------------------------------------

describe("growThread", () => {
  function seed(principal = 200) {
    return openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal,
      insuranceWeights: { E1: 0.6, E2: 0.4 },
    });
  }

  it("grows principal but leaves floatFace UNCHANGED", () => {
    const { floatsState, thread } = seed(200);
    const r = growThread({ floatsState, threadId: thread.id, gain: 25 });
    expect(r.gainApplied).toBe(25);
    const grown = r.floatsState.threads[0];
    expect(grown.principal).toBe(225);
    expect(grown.floatFace).toBe(200);
  });

  it("returns insuranceLayerAdds split by mix weights (layer 2)", () => {
    const { floatsState, thread } = seed(200);
    const r = growThread({ floatsState, threadId: thread.id, gain: 100 });
    expect(r.insuranceLayerAdds.E1).toBeCloseTo(60);
    expect(r.insuranceLayerAdds.E2).toBeCloseTo(40);
  });

  it("returns poolLayerAdd matching the gain (layer 3 — B-book pool)", () => {
    const { floatsState, thread } = seed(200);
    const r = growThread({ floatsState, threadId: thread.id, gain: 30 });
    expect(r.poolLayerAdd).toBe(30);
  });

  it("does NOT touch wallet FLOAT or mintedByUser (no auto-mint at layer 4)", () => {
    const { floatsState, thread } = seed(200);
    const before = balanceOf(floatsState, "A");
    const beforeMint = mintedByOf(floatsState, "A");
    const r = growThread({ floatsState, threadId: thread.id, gain: 50 });
    expect(balanceOf(r.floatsState, "A")).toBe(before);
    expect(mintedByOf(r.floatsState, "A")).toBe(beforeMint);
  });

  it("creates a buffer (principal − floatFace) that absorbs subsequent damage first", () => {
    let { floatsState, thread } = seed(100);
    // Grow 30 → principal 130, floatFace 100. Buffer = 30.
    floatsState = growThread({ floatsState, threadId: thread.id, gain: 30 }).floatsState;
    // Damage 20 — should eat into buffer only, floatFace stays at 100.
    const dmg = damageThread({ floatsState, threadId: thread.id, delta: 20 });
    const t = dmg.floatsState.threads[0];
    expect(t.principal).toBe(110);
    expect(t.floatFace).toBe(100);
    expect(dmg.floatFaceDelta).toBe(0);
  });

  it("damage above buffer eats principal AND floatFace pro-rata", () => {
    let { floatsState, thread } = seed(100);
    floatsState = growThread({ floatsState, threadId: thread.id, gain: 30 }).floatsState;
    const dmg = damageThread({ floatsState, threadId: thread.id, delta: 50 });
    const t = dmg.floatsState.threads[0];
    expect(t.principal).toBe(80);
    expect(t.floatFace).toBe(80);
    expect(dmg.floatFaceDelta).toBe(20);
  });

  it("zero gain is a no-op", () => {
    const { floatsState, thread } = seed();
    const r = growThread({ floatsState, threadId: thread.id, gain: 0 });
    expect(r.gainApplied).toBe(0);
    expect(r.floatsState).toBe(floatsState);
  });

  it("ignores closed threads", () => {
    const { floatsState, thread } = seed(50);
    const dmg = damageThread({ floatsState, threadId: thread.id, delta: 1e6 });
    expect(dmg.floatsState.threads[0].closed).toBe(true);
    const r = growThread({ floatsState: dmg.floatsState, threadId: thread.id, gain: 100 });
    expect(r.gainApplied).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

describe("transferFloats", () => {
  function seed() {
    return openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
    }).floatsState;
  }

  it("moves balance between wallets", () => {
    const r = transferFloats({ floatsState: seed(), fromId: "A", toId: "B", amount: 50 });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.floatsState, "A")).toBe(150);
    expect(balanceOf(r.floatsState, "B")).toBe(50);
  });

  it("MERCHANT recipient flows into merchantBalance", () => {
    const r = transferFloats({ floatsState: seed(), fromId: "A", toId: "MERCHANT", amount: 50 });
    expect(r.ok).toBe(true);
    expect(r.floatsState.merchantBalance).toBe(50);
    expect(balanceOf(r.floatsState, "A")).toBe(150);
  });

  it("rejects insufficient balance", () => {
    expect(
      transferFloats({ floatsState: initFloatsState(), fromId: "A", toId: "B", amount: 10 }).ok
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submit / cancel
// ---------------------------------------------------------------------------

describe("submitRedemption / cancelRedemption", () => {
  function seed() {
    return openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
    }).floatsState;
  }

  it("locks FLOAT into the queue", () => {
    const r = submitRedemption({
      floatsState: seed(),
      userId: "A",
      amount: 50,
      currentEpoch: 1,
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.floatsState, "A")).toBe(150);
    expect(r.floatsState.redemptionQueue).toHaveLength(1);
  });

  it("cancellation returns FLOAT to wallet", () => {
    const submitted = submitRedemption({
      floatsState: seed(),
      userId: "A",
      amount: 50,
      currentEpoch: 1,
    });
    const r = cancelRedemption({ floatsState: submitted.floatsState, requestId: submitted.requestId });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.floatsState, "A")).toBe(200);
    expect(r.floatsState.redemptionQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cycle drain — thread unwinds
// ---------------------------------------------------------------------------

describe("runRedemptionCycle", () => {
  function makeMintedState() {
    let s = initFloatsState();
    s = openThread({
      floatsState: s,
      ownerId: "A",
      principal: 100,
      insuranceWeights: { E1: 0.5, E2: 0.5 },
      currentEpoch: 0,
    }).floatsState;
    return s;
  }

  it("standard requests respect the supply cap and FIFO", () => {
    let s = makeMintedState();
    s = submitRedemption({ floatsState: s, userId: "A", amount: 8, currentEpoch: 1 }).floatsState;
    s = submitRedemption({ floatsState: s, userId: "A", amount: 8, currentEpoch: 1 }).floatsState;
    const result = runRedemptionCycle({ floatsState: s, currentEpoch: 1 });
    expect(result.floatsState.redemptionQueue).toHaveLength(1);
  });

  it("express requests bypass the cap and pay penalty to pool", () => {
    let s = makeMintedState();
    s = submitRedemption({
      floatsState: s,
      userId: "A",
      amount: 50,
      express: true,
      currentEpoch: 1,
    }).floatsState;
    const result = runRedemptionCycle({ floatsState: s, currentEpoch: 1 });
    expect(result.floatsState.redemptionQueue).toHaveLength(0);
    expect(result.dollarsOut.A).toBeCloseTo(50 * (1 - EXPRESS_PENALTY_RATE));
    expect(result.penaltyToPool).toBeCloseTo(50 * EXPRESS_PENALTY_RATE);
  });

  it("threadUnwinds give per-thread layer deltas the loop can apply", () => {
    let s = makeMintedState();
    s = submitRedemption({
      floatsState: s,
      userId: "A",
      amount: 8,
      currentEpoch: 1,
    }).floatsState;
    const result = runRedemptionCycle({ floatsState: s, currentEpoch: 1 });
    expect(result.threadUnwinds).toHaveLength(1);
    const u = result.threadUnwinds[0];
    expect(u.delta).toBeCloseTo(8);
    expect(u.poolLayerDelta).toBeCloseTo(8);
    expect(u.insuranceLayerDeltas.E1).toBeCloseTo(4);
    expect(u.insuranceLayerDeltas.E2).toBeCloseTo(4);
  });

  it("FIFO across discrete threads — oldest thread shrinks first", () => {
    let s = initFloatsState();
    s = openThread({
      floatsState: s,
      ownerId: "A",
      principal: 30,
      insuranceWeights: { E1: 1 },
      currentEpoch: 0,
    }).floatsState;
    s = openThread({
      floatsState: s,
      ownerId: "A",
      principal: 40,
      insuranceWeights: { E1: 1 },
      currentEpoch: 5,
    }).floatsState;
    s = transferFloats({ floatsState: s, fromId: "A", toId: "B", amount: 50 }).floatsState;
    s = submitRedemption({ floatsState: s, userId: "B", amount: 5, currentEpoch: 10 }).floatsState;
    const result = runRedemptionCycle({ floatsState: s, currentEpoch: 10 });
    expect(result.threadUnwinds).toHaveLength(1);
    expect(result.threadUnwinds[0].delta).toBeCloseTo(5);
  });

  it("empty queue is a no-op", () => {
    const result = runRedemptionCycle({ floatsState: initFloatsState(), currentEpoch: 5 });
    expect(result.dollarsOut).toEqual({});
    expect(result.threadUnwinds).toEqual([]);
    expect(result.penaltyToPool).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// solvency claw-back
// ---------------------------------------------------------------------------

describe("applySolvencyCheck", () => {
  it("does nothing when floatFace ≤ principal across the user's threads", () => {
    let s = openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
    }).floatsState;
    const result = applySolvencyCheck({ floatsState: s, userId: "A" });
    expect(result.clawback).toBe(0);
    expect(result.newDebt).toBe(0);
  });

  it("claws back from wallet first when a thread principal drops below floatFace", () => {
    let s = openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
    }).floatsState;
    s = {
      ...s,
      threads: s.threads.map((t) => ({ ...t, principal: 80, floatFace: 200 })),
    };
    const result = applySolvencyCheck({ floatsState: s, userId: "A" });
    expect(result.clawback).toBeCloseTo(120);
    expect(result.newDebt).toBe(0);
    expect(balanceOf(result.floatsState, "A")).toBeCloseTo(80);
  });

  it("records debt when wallet doesn't cover the shortfall", () => {
    let s = openThread({
      floatsState: initFloatsState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
    }).floatsState;
    s = transferFloats({ floatsState: s, fromId: "A", toId: "B", amount: 180 }).floatsState;
    s = {
      ...s,
      threads: s.threads.map((t) => ({ ...t, principal: 80, floatFace: 200 })),
    };
    const result = applySolvencyCheck({ floatsState: s, userId: "A" });
    expect(result.clawback).toBeCloseTo(20);
    expect(result.newDebt).toBeCloseTo(100);
    expect(debtOf(result.floatsState, "A")).toBeCloseTo(100);
  });
});
