import { describe, it, expect } from "vitest";
import {
  calcImbalancePremium,
  settleImbalanceContracts,
  calcEntropyContractPremium,
  settleEntropyContracts,
  calcExpectedMultiplier,
} from "../contracts.js";

describe("calcImbalancePremium (reflection-principle)", () => {
  it("produces a positive premium within reasonable bounds", () => {
    const p = calcImbalancePremium(1000, 1000);
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(0.5);
  });
  it("scales up on a skewed book", () => {
    const balanced = calcImbalancePremium(1000, 1000);
    const skewed = calcImbalancePremium(2000, 500);
    expect(skewed).toBeGreaterThan(balanced);
  });
  it("accepts strikeImbalance + windowN options", () => {
    const short = calcImbalancePremium(1000, 900, { strikeImbalance: 0.2, windowN: 5 });
    const long = calcImbalancePremium(1000, 900, { strikeImbalance: 0.2, windowN: 30 });
    expect(Number.isFinite(short)).toBe(true);
    expect(Number.isFinite(long)).toBe(true);
  });
});

describe("settleImbalanceContracts", () => {
  it("pays out when imbalance exceeds strike in direction", () => {
    const contracts = [
      { id: "c1", direction: "LONG", strikeImbalance: 0.3, size: 1000, premium: 0.005 },
    ];
    const { netPayout } = settleImbalanceContracts(contracts, 800, 200);
    expect(netPayout).toBeGreaterThan(0);
  });
  it("returns zero payout when strike not hit", () => {
    const contracts = [
      { id: "c2", direction: "LONG", strikeImbalance: 0.8, size: 1000, premium: 0.005 },
    ];
    const { netPayout } = settleImbalanceContracts(contracts, 550, 450);
    expect(netPayout).toBe(0);
  });
});

describe("entropy contracts", () => {
  it("premium scales with entropy spread", () => {
    const flat = calcEntropyContractPremium([0.25, 0.25, 0.25, 0.25], 1.2);
    const spread = calcEntropyContractPremium([0.05, 0.05, 0.3, 0.6], 1.2);
    expect(spread).toBeGreaterThan(flat);
  });
  it("pays when current mult exceeds locked", () => {
    const contracts = [{ id: "e1", size: 1000, lockedMult: 1.0, premium: 0.01 }];
    const { netPayout } = settleEntropyContracts(contracts, [0.3, 0.3, 0.4], 1.5);
    expect(netPayout).toBeGreaterThan(0);
  });
  it("no payout when current below locked", () => {
    const contracts = [{ id: "e2", size: 1000, lockedMult: 2.0, premium: 0.01 }];
    const { netPayout } = settleEntropyContracts(contracts, [0.3, 0.3, 0.4], 1.2);
    expect(netPayout).toBe(0);
  });
});

describe("calcExpectedMultiplier (OU §7.2)", () => {
  it("reverts locked multiplier toward 1", () => {
    const lockedHigh = 2.0;
    const expected = calcExpectedMultiplier(lockedHigh, 20, 0.15);
    expect(expected).toBeLessThan(lockedHigh);
    expect(expected).toBeGreaterThan(1);
  });

  it("returns locked value for N=0 (no reversion applied)", () => {
    expect(calcExpectedMultiplier(2.0, 0)).toBe(2.0);
  });

  it("larger λ produces stronger reversion", () => {
    const slow = calcExpectedMultiplier(2.0, 10, 0.05);
    const fast = calcExpectedMultiplier(2.0, 10, 0.5);
    expect(fast).toBeLessThan(slow);
  });
});
