import { describe, it, expect } from "vitest";
import {
  calcImbalancePremium,
  settleImbalanceContracts,
  calcEntropyContractPremium,
  settleEntropyContracts,
} from "../contracts.js";

describe("calcImbalancePremium", () => {
  it("is cheap on a balanced book", () => {
    const p = calcImbalancePremium(1000, 1000);
    expect(p).toBeCloseTo(0.005, 3);
  });
  it("is expensive on a skewed book", () => {
    const balanced = calcImbalancePremium(1000, 1000);
    const skewed = calcImbalancePremium(1000, 0);
    expect(skewed).toBeGreaterThan(balanced);
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
