import { describe, it, expect } from "vitest";
import {
  initGovernance,
  calcVotingWeight,
  createProposal,
  recordVote,
  resolveProposal,
  getGovernedParam,
  META_PARAM_SPEC,
} from "../governance.js";

describe("initGovernance", () => {
  it("starts with default active params + empty proposal list", () => {
    const g = initGovernance();
    expect(g.proposals).toEqual([]);
    expect(g.activeParams.ADAPTIVE_LR).toBe(META_PARAM_SPEC.ADAPTIVE_LR.default);
    expect(g.history).toEqual([]);
  });
});

describe("calcVotingWeight", () => {
  it("returns 0 for drive-by participants (no pool loyalty)", () => {
    expect(calcVotingWeight({ poolLoyaltyEpochs: 0, openPositions: [{}] })).toBe(0);
  });
  it("returns 0 when no floors touched even with loyalty", () => {
    expect(calcVotingWeight({ poolLoyaltyEpochs: 200 })).toBe(0);
  });
  it("weights loyalty 50%, engagement 30%, tenure 20%", () => {
    const w = calcVotingWeight({
      poolLoyaltyEpochs: 100,
      openPositions: [{}, {}],
      creditQualified: true,
      contractsWritten: 1,
      lendingOffers: 1,
      timeInProtocolEpochs: 200,
    });
    expect(w).toBeCloseTo(1, 1);
  });
  it("caps contributions at 1", () => {
    const w = calcVotingWeight({
      poolLoyaltyEpochs: 1000,
      openPositions: [{}, {}],
      creditQualified: true,
      contractsWritten: 10,
      lendingOffers: 10,
      timeInProtocolEpochs: 10000,
    });
    expect(w).toBeLessThanOrEqual(1);
  });
});

describe("createProposal", () => {
  it("clamps proposed value to param range", () => {
    const g = initGovernance();
    const r = createProposal(g, "ADAPTIVE_LR", 100, "A", 0);
    expect(r.ok).toBe(true);
    expect(r.proposal.proposedValue).toBeLessThanOrEqual(META_PARAM_SPEC.ADAPTIVE_LR.max);
  });
  it("rejects unknown parameters", () => {
    const g = initGovernance();
    const r = createProposal(g, "FAKE", 1, "A", 0);
    expect(r.ok).toBe(false);
  });
});

describe("recordVote / resolveProposal", () => {
  it("passing proposal updates activeParams", () => {
    let g = initGovernance();
    const r = createProposal(g, "ADAPTIVE_LR", 0.01, "A", 0);
    g = r.governance;
    g = recordVote(g, r.proposal.id, "A", 0.8, true);
    g = recordVote(g, r.proposal.id, "B", 0.4, true);
    g = resolveProposal(g, r.proposal.id, 10);
    expect(g.activeParams.ADAPTIVE_LR).toBe(0.01);
    expect(g.history.length).toBe(1);
  });

  it("rejected proposal leaves activeParams unchanged", () => {
    let g = initGovernance();
    const r = createProposal(g, "ADAPTIVE_LR", 0.02, "A", 0);
    g = r.governance;
    g = recordVote(g, r.proposal.id, "A", 0.3, true);
    g = recordVote(g, r.proposal.id, "B", 0.8, false);
    g = resolveProposal(g, r.proposal.id, 10);
    expect(g.activeParams.ADAPTIVE_LR).toBe(META_PARAM_SPEC.ADAPTIVE_LR.default);
  });

  it("re-voting flips the side atomically (no double-count)", () => {
    let g = initGovernance();
    const r = createProposal(g, "ENTROPY_BETA", 0.5, "A", 0);
    g = r.governance;
    g = recordVote(g, r.proposal.id, "A", 0.5, true);
    g = recordVote(g, r.proposal.id, "A", 0.5, false);
    const p = g.proposals.find((p) => p.id === r.proposal.id);
    expect(Object.keys(p.votesFor)).not.toContain("A");
    expect(Object.keys(p.votesAgainst)).toContain("A");
  });
});

describe("getGovernedParam", () => {
  it("falls back to default when missing", () => {
    expect(getGovernedParam(null, "ADAPTIVE_LR")).toBe(META_PARAM_SPEC.ADAPTIVE_LR.default);
  });
  it("returns active value when present", () => {
    const g = { activeParams: { ADAPTIVE_LR: 0.02 } };
    expect(getGovernedParam(g, "ADAPTIVE_LR")).toBe(0.02);
  });
});
