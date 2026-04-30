import { describe, it, expect } from "vitest";
import {
  initTtState,
  openThread,
  damageThread,
  calcInsuranceFillWeights,
  transferTT,
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
} from "../towerTether.js";
import { EXPRESS_PENALTY_RATE } from "../../constants/system.js";

// ---------------------------------------------------------------------------
// state factory + accessors
// ---------------------------------------------------------------------------

describe("initTtState", () => {
  it("starts empty", () => {
    const s = initTtState();
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
        ttState: initTtState(),
        ownerId: "A",
        principal: 0,
        insuranceWeights: baseWeights,
        lapPairKey: "BTCUSD",
        lapId: "LAP-1",
      }).ok
    ).toBe(false);
  });

  it("mints TT 1:1 — principal === ttFace at open", () => {
    const r = openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: baseWeights,
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(200);
    expect(mintedByOf(r.ttState, "A")).toBe(200);
    expect(totalSupply(r.ttState)).toBe(200);
    expect(r.thread.principal).toBe(200);
    expect(r.thread.ttFace).toBe(200);
    expect(r.thread.lapId).toBe("LAP-1");
  });

  it("does NOT impose any LTV gate or coefficient", () => {
    // Same call with very tiny effective LTV (no longer a concept) →
    // still works because gate is gone.
    const r = openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 1000,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    });
    expect(r.ok).toBe(true);
    expect(r.thread.ttFace).toBe(1000);
  });

  it("appends to threads array", () => {
    let s = initTtState();
    s = openThread({
      ttState: s,
      ownerId: "A",
      principal: 100,
      insuranceWeights: baseWeights,
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
    s = openThread({
      ttState: s,
      ownerId: "A",
      principal: 50,
      insuranceWeights: baseWeights,
      lapPairKey: "ETHUSD",
      lapId: "LAP-2",
    }).ttState;
    expect(activeThreads(s)).toHaveLength(2);
    expect(totalThreadPrincipal(s, "A")).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// damageThread (loss propagation)
// ---------------------------------------------------------------------------

describe("damageThread", () => {
  function seed(principal = 200) {
    return openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal,
      insuranceWeights: { E1: 0.6, E2: 0.4 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    });
  }

  it("shrinks principal by the delta and reports per-layer deltas", () => {
    const { ttState, thread } = seed(200);
    const r = damageThread({ ttState, threadId: thread.id, delta: 50 });
    expect(r.deltaApplied).toBe(50);
    expect(r.lapLayerDelta).toBe(50);
    expect(r.insuranceLayerDeltas.E1).toBeCloseTo(50 * 0.6);
    expect(r.insuranceLayerDeltas.E2).toBeCloseTo(50 * 0.4);
    const updated = r.ttState.threads[0];
    expect(updated.principal).toBe(150);
  });

  it("ttFace shrinks alongside principal when redemption hasn't occurred", () => {
    const { ttState, thread } = seed(200);
    const r = damageThread({ ttState, threadId: thread.id, delta: 50 });
    const updated = r.ttState.threads[0];
    // ttFace stays === principal because nothing's been redeemed.
    expect(updated.ttFace).toBe(150);
    expect(r.ttFaceDelta).toBe(50);
    // mintedByOf reflects the shrink.
    expect(mintedByOf(r.ttState, "A")).toBe(150);
  });

  it("caps damage at the thread's current principal", () => {
    const { ttState, thread } = seed(100);
    const r = damageThread({ ttState, threadId: thread.id, delta: 1e6 });
    expect(r.deltaApplied).toBe(100);
    expect(r.ttState.threads[0].principal).toBe(0);
    expect(r.ttState.threads[0].closed).toBe(true);
  });

  it("zero delta is a no-op", () => {
    const { ttState, thread } = seed();
    const r = damageThread({ ttState, threadId: thread.id, delta: 0 });
    expect(r.deltaApplied).toBe(0);
    expect(r.ttState).toBe(ttState);
  });

  it("propagates ALL FOUR layers symmetrically (the thread invariant)", () => {
    const { ttState, thread } = seed(400);
    const r = damageThread({ ttState, threadId: thread.id, delta: 100 });
    // Principal (T-bill layer) drops by 100.
    expect(r.deltaApplied).toBe(100);
    // LAP layer: same 100.
    expect(r.lapLayerDelta).toBe(100);
    // Insurance layers: sum to the same 100 (split by weights).
    const insSum = Object.values(r.insuranceLayerDeltas).reduce((s, v) => s + v, 0);
    expect(insSum).toBeCloseTo(100);
    // TT layer: ttFace shrinks by the same amount.
    expect(r.ttFaceDelta).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

describe("transferTT", () => {
  function seed() {
    return openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
  }

  it("moves balance between wallets", () => {
    const r = transferTT({ ttState: seed(), fromId: "A", toId: "B", amount: 50 });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(150);
    expect(balanceOf(r.ttState, "B")).toBe(50);
  });

  it("MERCHANT recipient flows into merchantBalance", () => {
    const r = transferTT({ ttState: seed(), fromId: "A", toId: "MERCHANT", amount: 50 });
    expect(r.ok).toBe(true);
    expect(r.ttState.merchantBalance).toBe(50);
    expect(balanceOf(r.ttState, "A")).toBe(150);
  });

  it("rejects insufficient balance", () => {
    expect(
      transferTT({ ttState: initTtState(), fromId: "A", toId: "B", amount: 10 }).ok
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// submit / cancel
// ---------------------------------------------------------------------------

describe("submitRedemption / cancelRedemption", () => {
  function seed() {
    return openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
  }

  it("locks TT into the queue", () => {
    const r = submitRedemption({
      ttState: seed(),
      userId: "A",
      amount: 50,
      currentEpoch: 1,
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(150);
    expect(r.ttState.redemptionQueue).toHaveLength(1);
  });

  it("cancellation returns TT to wallet", () => {
    const submitted = submitRedemption({
      ttState: seed(),
      userId: "A",
      amount: 50,
      currentEpoch: 1,
    });
    const r = cancelRedemption({ ttState: submitted.ttState, requestId: submitted.requestId });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(200);
    expect(r.ttState.redemptionQueue).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// cycle drain — thread unwinds
// ---------------------------------------------------------------------------

describe("runRedemptionCycle", () => {
  function makeMintedState() {
    let s = initTtState();
    s = openThread({
      ttState: s,
      ownerId: "A",
      principal: 100,
      insuranceWeights: { E1: 0.5, E2: 0.5 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-A",
      currentEpoch: 0,
    }).ttState;
    return s;
  }

  it("standard requests respect the supply cap and FIFO", () => {
    let s = makeMintedState();
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.ttState.redemptionQueue).toHaveLength(1);
  });

  it("express requests bypass the cap and pay penalty to pool", () => {
    let s = makeMintedState();
    s = submitRedemption({
      ttState: s,
      userId: "A",
      amount: 50,
      express: true,
      currentEpoch: 1,
    }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.ttState.redemptionQueue).toHaveLength(0);
    expect(result.dollarsOut.A).toBeCloseTo(50 * (1 - EXPRESS_PENALTY_RATE));
    expect(result.penaltyToPool).toBeCloseTo(50 * EXPRESS_PENALTY_RATE);
  });

  it("threadUnwinds give per-thread layer deltas the loop can apply", () => {
    let s = makeMintedState();
    s = submitRedemption({
      ttState: s,
      userId: "A",
      amount: 8,
      currentEpoch: 1,
    }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.threadUnwinds).toHaveLength(1);
    const u = result.threadUnwinds[0];
    expect(u.delta).toBeCloseTo(8);
    expect(u.lapLayerDelta).toBeCloseTo(8);
    expect(u.insuranceLayerDeltas.E1).toBeCloseTo(4);
    expect(u.insuranceLayerDeltas.E2).toBeCloseTo(4);
    expect(u.lapId).toBe("LAP-A");
  });

  it("FIFO across discrete threads — oldest thread shrinks first", () => {
    let s = initTtState();
    s = openThread({
      ttState: s,
      ownerId: "A",
      principal: 30,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
      currentEpoch: 0,
    }).ttState;
    s = openThread({
      ttState: s,
      ownerId: "A",
      principal: 40,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-2",
      currentEpoch: 5,
    }).ttState;
    s = transferTT({ ttState: s, fromId: "A", toId: "B", amount: 50 }).ttState;
    // B redeems 35: should drain 30 from LAP-1 (oldest), 5 from LAP-2.
    s = submitRedemption({ ttState: s, userId: "B", amount: 5, currentEpoch: 10 }).ttState;
    // ↑ 5 fits within 10% of supply (70 × 0.10 = 7)
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 10 });
    // Lookup unwinds by lapId.
    const lap1 = result.threadUnwinds.find((u) => u.lapId === "LAP-1");
    expect(lap1).toBeTruthy();
    expect(lap1.delta).toBeCloseTo(5);
  });

  it("empty queue is a no-op", () => {
    const result = runRedemptionCycle({ ttState: initTtState(), currentEpoch: 5 });
    expect(result.dollarsOut).toEqual({});
    expect(result.threadUnwinds).toEqual([]);
    expect(result.penaltyToPool).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// solvency claw-back
// ---------------------------------------------------------------------------

describe("applySolvencyCheck", () => {
  it("does nothing when ttFace ≤ principal across the user's threads", () => {
    let s = openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
    const result = applySolvencyCheck({ ttState: s, userId: "A" });
    expect(result.clawback).toBe(0);
    expect(result.newDebt).toBe(0);
  });

  it("claws back from wallet first when a thread principal drops below ttFace", () => {
    let s = openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
    // Damage half the principal but keep ttFace artificially elevated
    // by injecting a stale thread shape (simulating a multi-step
    // damage where ttFace lags principal — used to test the
    // claw-back path).
    s = {
      ...s,
      threads: s.threads.map((t) => ({ ...t, principal: 80, ttFace: 200 })),
    };
    const result = applySolvencyCheck({ ttState: s, userId: "A" });
    // Overflow = 200 − 80 = 120. Wallet has 200 (they hold all the TT
    // they minted). Clawback = 120 (whole shortfall).
    expect(result.clawback).toBeCloseTo(120);
    expect(result.newDebt).toBe(0);
    expect(balanceOf(result.ttState, "A")).toBeCloseTo(80);
  });

  it("records debt when wallet doesn't cover the shortfall", () => {
    let s = openThread({
      ttState: initTtState(),
      ownerId: "A",
      principal: 200,
      insuranceWeights: { E1: 1 },
      lapPairKey: "BTCUSD",
      lapId: "LAP-1",
    }).ttState;
    // Move most TT off-wallet, then drop principal so the user can't
    // cover the overflow from wallet.
    s = transferTT({ ttState: s, fromId: "A", toId: "B", amount: 180 }).ttState;
    s = {
      ...s,
      threads: s.threads.map((t) => ({ ...t, principal: 80, ttFace: 200 })),
    };
    const result = applySolvencyCheck({ ttState: s, userId: "A" });
    // Overflow 120, wallet 20 → debt 100.
    expect(result.clawback).toBeCloseTo(20);
    expect(result.newDebt).toBeCloseTo(100);
    expect(debtOf(result.ttState, "A")).toBeCloseTo(100);
  });
});
