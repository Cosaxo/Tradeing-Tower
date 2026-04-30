import { describe, it, expect } from "vitest";
import {
  initTtState,
  mintCapacity,
  mintTT,
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
  TT_REINS_OVERSIZE,
} from "../towerTether.js";
import {
  MINT_COEFFICIENT,
  MINT_LTV_GATE,
  EXPRESS_PENALTY_RATE,
} from "../../constants/system.js";

// ---------------------------------------------------------------------------
// state factory + accessors
// ---------------------------------------------------------------------------

describe("initTtState", () => {
  it("starts empty", () => {
    const s = initTtState();
    expect(totalSupply(s)).toBe(0);
    expect(totalCirculating(s)).toBe(0);
    expect(s.redemptionQueue).toEqual([]);
    expect(s.merchantBalance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mint capacity
// ---------------------------------------------------------------------------

describe("mintCapacity", () => {
  it("returns 0 below the LTV gate", () => {
    const s = initTtState();
    expect(
      mintCapacity({ ttState: s, userId: "A", totalStake: 1000, ltv: MINT_LTV_GATE - 0.01 })
    ).toBe(0);
  });

  it("equals totalStake × ltv × MINT_COEFFICIENT at the gate", () => {
    const s = initTtState();
    const cap = mintCapacity({
      ttState: s,
      userId: "A",
      totalStake: 1000,
      ltv: 0.8,
    });
    expect(cap).toBeCloseTo(1000 * 0.8 * MINT_COEFFICIENT);
  });

  it("subtracts existing minted + debt", () => {
    const s = { ...initTtState(), mintedByUser: { A: 100 }, debtByUser: { A: 50 } };
    const cap = mintCapacity({
      ttState: s,
      userId: "A",
      totalStake: 1000,
      ltv: 1.0,
    });
    // raw cap = 1000 × 1.0 × 0.5 = 500. Outstanding = 100 + 50 = 150.
    expect(cap).toBeCloseTo(350);
  });
});

// ---------------------------------------------------------------------------
// mint
// ---------------------------------------------------------------------------

describe("mintTT", () => {
  it("rejects below the LTV gate", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 100,
      totalStake: 1000,
      ltv: 0.5,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects amounts above capacity", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 10000,
      totalStake: 1000,
      ltv: 1.0,
    });
    expect(r.ok).toBe(false);
  });

  it("credits both wallet and outstanding mint on success", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(200);
    expect(mintedByOf(r.ttState, "A")).toBe(200);
    expect(totalSupply(r.ttState)).toBe(200);
  });

  it("returns reinsuranceFacePerProduct = mint × 1.5 / 3 (1.5× rule)", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 300,
      totalStake: 1000,
      ltv: 1.0,
    });
    expect(r.reinsuranceFacePerProduct).toBeCloseTo((300 * TT_REINS_OVERSIZE) / 3);
  });
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

describe("transferTT", () => {
  function seed() {
    return mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
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
// redemption queue
// ---------------------------------------------------------------------------

describe("submitRedemption / cancelRedemption", () => {
  function seed() {
    return mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
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
// cycle drain
// ---------------------------------------------------------------------------

describe("runRedemptionCycle", () => {
  it("standard requests respect the supply cap and FIFO", () => {
    let s = initTtState();
    s = mintTT({ ttState: s, userId: "A", amount: 100, totalStake: 1000, ltv: 1 }).ttState;
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.ttState.redemptionQueue).toHaveLength(1);
  });

  it("express requests bypass the cap and pay penalty to pool", () => {
    let s = initTtState();
    s = mintTT({ ttState: s, userId: "A", amount: 100, totalStake: 1000, ltv: 1 }).ttState;
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

  it("collateralHaircuts spread pro-rata across all minters", () => {
    let s = initTtState();
    s = mintTT({ ttState: s, userId: "A", amount: 100, totalStake: 1000, ltv: 1 }).ttState;
    s = mintTT({ ttState: s, userId: "B", amount: 100, totalStake: 1000, ltv: 1 }).ttState;
    s = transferTT({ ttState: s, fromId: "A", toId: "C", amount: 60 }).ttState;
    s = submitRedemption({ ttState: s, userId: "C", amount: 20, currentEpoch: 1 }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.collateralHaircuts.A).toBeCloseTo(10);
    expect(result.collateralHaircuts.B).toBeCloseTo(10);
  });

  it("empty queue is a no-op", () => {
    const result = runRedemptionCycle({ ttState: initTtState(), currentEpoch: 5 });
    expect(result.dollarsOut).toEqual({});
    expect(result.collateralHaircuts).toEqual({});
    expect(result.penaltyToPool).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// solvency claw-back
// ---------------------------------------------------------------------------

describe("applySolvencyCheck", () => {
  it("does nothing when outstanding mint fits within new cap", () => {
    let s = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
    }).ttState;
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newTotalStake: 800,
      ltv: 1.0,
    });
    expect(result.clawback).toBe(0);
    expect(result.newDebt).toBe(0);
  });

  it("claws back from wallet first when stake drops", () => {
    let s = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
    }).ttState;
    // Stake drops to 200 → cap = 100. Outstanding 200 → overflow 100.
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newTotalStake: 200,
      ltv: 1.0,
    });
    expect(result.clawback).toBeCloseTo(100);
    expect(result.newDebt).toBe(0);
    expect(balanceOf(result.ttState, "A")).toBeCloseTo(100);
    expect(mintedByOf(result.ttState, "A")).toBeCloseTo(100);
  });

  it("records debt when wallet doesn't cover the shortfall", () => {
    let s = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      totalStake: 1000,
      ltv: 1.0,
    }).ttState;
    s = transferTT({ ttState: s, fromId: "A", toId: "B", amount: 180 }).ttState;
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newTotalStake: 200,
      ltv: 1.0,
    });
    expect(result.clawback).toBeCloseTo(20);
    expect(result.newDebt).toBeCloseTo(80);
    expect(debtOf(result.ttState, "A")).toBeCloseTo(80);
  });
});
