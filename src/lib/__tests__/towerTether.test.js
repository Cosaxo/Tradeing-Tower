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

describe("balanceOf / mintedByOf / debtOf", () => {
  it("read missing users as 0", () => {
    const s = initTtState();
    expect(balanceOf(s, "Nobody")).toBe(0);
    expect(mintedByOf(s, "Nobody")).toBe(0);
    expect(debtOf(s, "Nobody")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// mint capacity gating
// ---------------------------------------------------------------------------

describe("mintCapacity", () => {
  it("returns 0 below the LTV gate", () => {
    const s = initTtState();
    expect(
      mintCapacity({ ttState: s, userId: "A", deposit: 1000, ltv: MINT_LTV_GATE - 0.01 })
    ).toBe(0);
  });

  it("equals deposit × ltv × MINT_COEFFICIENT at the gate", () => {
    const s = initTtState();
    const cap = mintCapacity({
      ttState: s,
      userId: "A",
      deposit: 1000,
      ltv: 0.8,
    });
    expect(cap).toBeCloseTo(1000 * 0.8 * MINT_COEFFICIENT);
  });

  it("subtracts existing minted + debt", () => {
    let s = initTtState();
    s = { ...s, mintedByUser: { A: 100 }, debtByUser: { A: 50 } };
    const cap = mintCapacity({
      ttState: s,
      userId: "A",
      deposit: 1000,
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
      deposit: 1000,
      ltv: 0.5,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects amounts above capacity", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 10000,
      deposit: 1000,
      ltv: 1.0,
    });
    expect(r.ok).toBe(false);
  });

  it("credits both wallet and outstanding mint on success", () => {
    const r = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      deposit: 1000,
      ltv: 1.0,
    });
    expect(r.ok).toBe(true);
    expect(balanceOf(r.ttState, "A")).toBe(200);
    expect(mintedByOf(r.ttState, "A")).toBe(200);
    expect(totalSupply(r.ttState)).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// transfer / merchant
// ---------------------------------------------------------------------------

describe("transferTT", () => {
  function seed() {
    return mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      deposit: 1000,
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
    const r = transferTT({
      ttState: initTtState(),
      fromId: "A",
      toId: "B",
      amount: 10,
    });
    expect(r.ok).toBe(false);
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
      deposit: 1000,
      ltv: 1.0,
    }).ttState;
  }

  it("locks TT into the queue and removes it from wallet", () => {
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

  it("cancellation returns TT to the wallet", () => {
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
  function seedTwoMintersOneRedeemer() {
    let s = initTtState();
    s = mintTT({ ttState: s, userId: "A", amount: 100, deposit: 1000, ltv: 1 }).ttState;
    s = mintTT({ ttState: s, userId: "B", amount: 100, deposit: 1000, ltv: 1 }).ttState;
    // C buys some TT off A (transfer simulation):
    s = transferTT({ ttState: s, fromId: "A", toId: "C", amount: 60 }).ttState;
    // C queues a redemption.
    s = submitRedemption({ ttState: s, userId: "C", amount: 20, currentEpoch: 1 }).ttState;
    return s;
  }

  it("standard requests respect the supply cap and FIFO", () => {
    let s = initTtState();
    // Total supply 100; cap = 10.
    s = mintTT({ ttState: s, userId: "A", amount: 100, deposit: 1000, ltv: 1 }).ttState;
    // A queues two requests of 8 each — first should clear, second blocked by cap.
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    s = submitRedemption({ ttState: s, userId: "A", amount: 8, currentEpoch: 1 }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    // Only the first 8 cleared. Cap = 100 × 0.10 = 10; first 8 cleared,
    // second 8 would push to 16 > 10, so deferred.
    expect(result.ttState.redemptionQueue).toHaveLength(1);
  });

  it("express requests clear regardless of cap and pay penalty to pool", () => {
    let s = initTtState();
    s = mintTT({ ttState: s, userId: "A", amount: 100, deposit: 1000, ltv: 1 }).ttState;
    s = submitRedemption({
      ttState: s,
      userId: "A",
      amount: 50,         // way above 10% cap of 10
      express: true,
      currentEpoch: 1,
    }).ttState;
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    expect(result.ttState.redemptionQueue).toHaveLength(0);
    expect(result.dollarsOut.A).toBeCloseTo(50 * (1 - EXPRESS_PENALTY_RATE));
    expect(result.penaltyToPool).toBeCloseTo(50 * EXPRESS_PENALTY_RATE);
  });

  it("pro-rata haircuts spread across all current minters", () => {
    const s = seedTwoMintersOneRedeemer();
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 1 });
    // C redeems 20. Total minted was 200 (A=100, B=100); pre-redeem
    // each had 50% share. So A and B each lose ~10 collateral / mint.
    expect(result.collateralHaircuts.A).toBeCloseTo(10);
    expect(result.collateralHaircuts.B).toBeCloseTo(10);
    expect(result.ttState.mintedByUser.A).toBeCloseTo(90);
    expect(result.ttState.mintedByUser.B).toBeCloseTo(90);
  });

  it("empty queue is a no-op", () => {
    const s = initTtState();
    const result = runRedemptionCycle({ ttState: s, currentEpoch: 5 });
    expect(result.dollarsOut).toEqual({});
    expect(result.collateralHaircuts).toEqual({});
    expect(result.penaltyToPool).toBe(0);
    expect(result.ttState.lastRedemptionEpoch).toBe(5);
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
      deposit: 1000,
      ltv: 1.0,
    }).ttState;
    // Deposit dropped from 1000 → 800; cap = 800 × 1 × 0.5 = 400.
    // Outstanding mint = 200 still fits.
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newDeposit: 800,
      ltv: 1.0,
    });
    expect(result.clawback).toBe(0);
    expect(result.newDebt).toBe(0);
  });

  it("claws back from wallet first when outstanding exceeds new cap", () => {
    let s = mintTT({
      ttState: initTtState(),
      userId: "A",
      amount: 200,
      deposit: 1000,
      ltv: 1.0,
    }).ttState;
    // Deposit drops to 200; new cap = 100. Outstanding mint = 200, overflow = 100.
    // Wallet has 200 TT — full overflow clawed back from wallet, no debt.
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newDeposit: 200,
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
      deposit: 1000,
      ltv: 1.0,
    }).ttState;
    // Spend 180 of the 200 TT to drain wallet.
    s = transferTT({ ttState: s, fromId: "A", toId: "B", amount: 180 }).ttState;
    // Now deposit drops; overflow = 100 but wallet only has 20.
    const result = applySolvencyCheck({
      ttState: s,
      userId: "A",
      newDeposit: 200,
      ltv: 1.0,
    });
    expect(result.clawback).toBeCloseTo(20);
    expect(result.newDebt).toBeCloseTo(80);
    expect(debtOf(result.ttState, "A")).toBeCloseTo(80);
  });
});
