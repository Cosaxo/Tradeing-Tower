// Floor 5 — protocol governance (whitepaper §10.7).
//
// Voting weight = f(pool loyalty, multi-floor engagement, time-in-protocol).
// NOT raw capital. A whale with one-epoch pool deposits has no influence.
//
// Current code already has the adaptation mechanics (Section 4.5);
// this layer governs the *outer bounds* on learning rates and caps the
// KL-gradient descent stays within.

import { ACTIVE_PAIRS } from "../constants/assets.js";

// Meta-parameters controllable by Floor 5 votes.
// Each has a default, a soft range, and a current value (hydrated from votes).
export const META_PARAM_SPEC = {
  ADAPTIVE_LR: { default: 0.005, min: 0.0005, max: 0.05, label: "KL-gradient learning rate" },
  ENTROPY_BETA: { default: 0.3, min: 0.1, max: 0.9, label: "Fill-ratio EMA decay" },
  SOFT_CLOSE_PCT: { default: 0.8, min: 0.5, max: 0.95, label: "Intra-epoch bid-freeze window" },
  POOL_STABILITY_FEE: { default: 0.02, min: 0.005, max: 0.1, label: "Stability fee as % of tips" },
  POOL_LOCKUP_EPOCHS: { default: 50, min: 10, max: 200, label: "Pool lockup duration" },
  POOL_MAX_CLAIM_RATIO: { default: 0.5, min: 0.2, max: 0.8, label: "Pool claim cap per slow epoch" },
  TIER_SAFE_PCT: { default: 0.4, min: 0.2, max: 0.6, label: "SAFE-tier share" },
  TIER_MEDIUM_PCT: { default: 0.3, min: 0.15, max: 0.5, label: "MEDIUM-tier share" },
};

export const META_PARAM_KEYS = Object.keys(META_PARAM_SPEC);

// Voting weight (§10.7):
//   base weight from pool loyalty (epochs held) +
//   multi-floor engagement bonus (active positions, credit qualification, contracts, lending) +
//   time-in-protocol bonus
// Raw capital is NOT a factor. Returns a numeric weight.
export function calcVotingWeight({
  poolLoyaltyEpochs = 0,
  openPositions = [],
  creditQualified = false,
  contractsWritten = 0,
  lendingOffers = 0,
  timeInProtocolEpochs = 0,
}) {
  const loyaltyScore = Math.min(1, poolLoyaltyEpochs / 100); // cap at 100 epochs
  const floorsTouched =
    (openPositions.length > 0 ? 1 : 0) +
    (creditQualified ? 1 : 0) +
    (contractsWritten > 0 ? 1 : 0) +
    (lendingOffers > 0 ? 1 : 0);
  const engagementScore = Math.min(1, floorsTouched / 4);
  const tenureScore = Math.min(1, timeInProtocolEpochs / 200);

  // Require minimum commitment; zero weight for drive-bys.
  if (poolLoyaltyEpochs < 100) return 0;
  if (floorsTouched === 0) return 0;

  return parseFloat(
    (loyaltyScore * 0.5 + engagementScore * 0.3 + tenureScore * 0.2).toFixed(4)
  );
}

// Initialise an empty governance state.
export function initGovernance() {
  return {
    proposals: [], // { id, paramKey, proposedValue, votesFor: {id:weight}, votesAgainst, createdEpoch, status }
    activeParams: Object.fromEntries(
      META_PARAM_KEYS.map((k) => [k, META_PARAM_SPEC[k].default])
    ),
    history: [], // { epoch, paramKey, oldValue, newValue, totalVotesFor, totalVotesAgainst }
  };
}

// Create a new proposal. Clamps value to the param's allowed range.
let proposalIdCounter = 0;
export function createProposal(governance, paramKey, proposedValue, proposerId, epoch) {
  const spec = META_PARAM_SPEC[paramKey];
  if (!spec) return { ok: false, reason: "Unknown parameter" };
  const clamped = Math.max(spec.min, Math.min(spec.max, proposedValue));
  const prop = {
    id: `PROP-${++proposalIdCounter}`,
    paramKey,
    proposedValue: clamped,
    proposerId,
    createdEpoch: epoch,
    votesFor: {},
    votesAgainst: {},
    status: "open",
  };
  return {
    ok: true,
    governance: { ...governance, proposals: [...governance.proposals, prop] },
    proposal: prop,
  };
}

// Record a vote. Voter's weight is stored per-proposal (can be re-evaluated later).
export function recordVote(governance, proposalId, voterId, weight, support) {
  const proposals = governance.proposals.map((p) => {
    if (p.id !== proposalId || p.status !== "open") return p;
    const otherMap = support ? p.votesAgainst : p.votesFor;
    const { [voterId]: _removed, ...restOther } = otherMap;
    void _removed;
    return {
      ...p,
      votesFor: support ? { ...p.votesFor, [voterId]: weight } : restOther,
      votesAgainst: support ? restOther : { ...p.votesAgainst, [voterId]: weight },
    };
  });
  return { ...governance, proposals };
}

// Close a proposal that has reached its vote threshold or timeout.
export function resolveProposal(governance, proposalId, epoch) {
  const target = governance.proposals.find((p) => p.id === proposalId);
  if (!target || target.status !== "open") return governance;

  const forTotal = Object.values(target.votesFor).reduce((s, v) => s + v, 0);
  const againstTotal = Object.values(target.votesAgainst).reduce((s, v) => s + v, 0);
  const passed = forTotal > againstTotal && forTotal >= 0.5;

  const resolved = {
    ...target,
    status: passed ? "passed" : "rejected",
    resolvedEpoch: epoch,
    totalVotesFor: forTotal,
    totalVotesAgainst: againstTotal,
  };

  const activeParams = passed
    ? { ...governance.activeParams, [target.paramKey]: target.proposedValue }
    : governance.activeParams;

  const historyEntry = passed
    ? {
        epoch,
        paramKey: target.paramKey,
        oldValue: governance.activeParams[target.paramKey],
        newValue: target.proposedValue,
        totalVotesFor: forTotal,
        totalVotesAgainst: againstTotal,
      }
    : null;

  return {
    ...governance,
    activeParams,
    history: historyEntry ? [...governance.history, historyEntry] : governance.history,
    proposals: governance.proposals.map((p) => (p.id === proposalId ? resolved : p)),
  };
}

// Return the live value of a governed parameter.
export function getGovernedParam(governance, paramKey) {
  if (!governance?.activeParams) return META_PARAM_SPEC[paramKey]?.default;
  return governance.activeParams[paramKey] ?? META_PARAM_SPEC[paramKey]?.default;
}

void ACTIVE_PAIRS;
