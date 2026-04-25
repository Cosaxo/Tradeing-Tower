import { describe, it, expect } from "vitest";
import { shouldUnwindCredit, calcPairCreditEligibility } from "../credit.js";

describe("shouldUnwindCredit", () => {
  it("is false when no credit is deployed", () => {
    expect(shouldUnwindCredit(5000, 0)).toBe(false);
  });

  it("fires when equity drops to deployed credit", () => {
    expect(shouldUnwindCredit(1000, 1000)).toBe(true);
    expect(shouldUnwindCredit(999, 1000)).toBe(true);
  });

  it("does not fire while equity is still above deployed credit", () => {
    expect(shouldUnwindCredit(1500, 1000)).toBe(false);
  });
});

describe("calcPairCreditEligibility", () => {
  it("blocks a third position on a pair already holding long+short", () => {
    const result = calcPairCreditEligibility("EURUSD", [
      { pairKey: "EURUSD", side: "LONG" },
      { pairKey: "EURUSD", side: "SHORT" },
    ]);
    expect(result.eligible).toBe(false);
    expect(result.reason).toMatch(/long\+short/i);
  });

  it("allows opening on a pair with one existing position", () => {
    const result = calcPairCreditEligibility("EURUSD", [
      { pairKey: "EURUSD", side: "LONG" },
    ]);
    expect(result.eligible).toBe(true);
  });

  it("allows opening on an empty book", () => {
    expect(calcPairCreditEligibility("EURUSD", []).eligible).toBe(true);
  });
});
