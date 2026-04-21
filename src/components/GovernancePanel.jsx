// Floor 5 governance (§10.7).
// Shows voting weight, current governed params, open proposals, and lets the
// player propose/vote on parameter changes.
import { useState } from "react";
import {
  META_PARAM_SPEC,
  META_PARAM_KEYS,
  createProposal,
  recordVote,
  resolveProposal,
  calcVotingWeight,
} from "../lib/governance.js";
import { HelpHint } from "./Tooltip.jsx";

export function GovernancePanel({
  governance,
  setGovernance,
  playerId = "You",
  playerContext = {},
  currentEpoch = 0,
}) {
  const [selectedParam, setSelectedParam] = useState(META_PARAM_KEYS[0]);
  const [proposedValue, setProposedValue] = useState(
    META_PARAM_SPEC[META_PARAM_KEYS[0]].default
  );

  const weight = calcVotingWeight(playerContext);
  const canVote = weight > 0;
  const canPropose = weight >= 0.1;

  function handlePropose() {
    const result = createProposal(governance, selectedParam, proposedValue, playerId, currentEpoch);
    if (result.ok) setGovernance(result.governance);
  }

  function handleVote(proposalId, support) {
    setGovernance((g) => recordVote(g, proposalId, playerId, weight, support));
  }

  function handleResolve(proposalId) {
    setGovernance((g) => resolveProposal(g, proposalId, currentEpoch));
  }

  const openProposals = (governance.proposals ?? []).filter((p) => p.status === "open");
  const historyTail = (governance.history ?? []).slice(-5).reverse();

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Governance · Floor 5
          <HelpHint
            width={280}
            text="Voting weight comes from pool loyalty + multi-floor engagement + time in protocol. Raw capital doesn't count. Min 100 epochs of pool loyalty required to cast a vote. Proposals bound the KL-gradient adaptor to outer ranges."
          />
        </span>
        <span
          className="text-[10px] font-mono px-2 py-0.5 rounded"
          style={{
            background: canVote ? "#065f4633" : "#37415133",
            color: canVote ? "#34d399" : "#9ca3af",
          }}
        >
          weight {(weight * 100).toFixed(0)}%
        </span>
      </div>

      {/* Active parameters */}
      <div className="flex flex-col gap-1">
        <span className="text-[10px] font-mono text-gray-500 uppercase">
          Active Parameters
        </span>
        <div className="grid grid-cols-2 gap-1">
          {META_PARAM_KEYS.map((k) => {
            const spec = META_PARAM_SPEC[k];
            const cur = governance?.activeParams?.[k] ?? spec.default;
            const atDefault = Math.abs(cur - spec.default) < 1e-9;
            return (
              <div
                key={k}
                className="flex items-center justify-between rounded border border-gray-800 bg-gray-950 px-2 py-1"
                title={spec.label}
              >
                <span className="text-[9px] font-mono text-gray-400 truncate">
                  {k}
                </span>
                <span
                  className="text-[9px] font-mono"
                  style={{ color: atDefault ? "#9ca3af" : "#818cf8" }}
                >
                  {Number.isInteger(cur) ? cur : cur.toFixed(4)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      {/* Propose */}
      {canPropose && (
        <div className="flex flex-col gap-1.5 rounded border border-gray-800 bg-gray-950 p-2">
          <span className="text-[10px] font-mono text-gray-400 uppercase">Propose change</span>
          <div className="flex gap-1 items-center">
            <select
              value={selectedParam}
              onChange={(e) => {
                setSelectedParam(e.target.value);
                setProposedValue(META_PARAM_SPEC[e.target.value].default);
              }}
              className="flex-1 text-[10px] font-mono rounded border border-gray-700 bg-gray-900 text-gray-200 px-1 py-0.5"
            >
              {META_PARAM_KEYS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
            <input
              type="number"
              value={proposedValue}
              step={META_PARAM_SPEC[selectedParam].default / 10}
              min={META_PARAM_SPEC[selectedParam].min}
              max={META_PARAM_SPEC[selectedParam].max}
              onChange={(e) => setProposedValue(parseFloat(e.target.value))}
              className="w-20 text-[10px] font-mono rounded border border-gray-700 bg-gray-900 text-gray-200 px-1 py-0.5"
            />
            <button
              onClick={handlePropose}
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-indigo-700 text-indigo-300 hover:bg-indigo-950 transition-colors"
            >
              propose
            </button>
          </div>
          <div className="text-[9px] font-mono text-gray-600">
            range {META_PARAM_SPEC[selectedParam].min} – {META_PARAM_SPEC[selectedParam].max} ·{" "}
            {META_PARAM_SPEC[selectedParam].label}
          </div>
        </div>
      )}

      {/* Open proposals */}
      {openProposals.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-500 uppercase">
            Open Proposals ({openProposals.length})
          </span>
          {openProposals.map((p) => {
            const forTotal = Object.values(p.votesFor ?? {}).reduce((s, v) => s + v, 0);
            const againstTotal = Object.values(p.votesAgainst ?? {}).reduce((s, v) => s + v, 0);
            const net = forTotal - againstTotal;
            return (
              <div
                key={p.id}
                className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-1"
              >
                <div className="flex items-center justify-between text-[10px] font-mono">
                  <span className="text-gray-300">{p.paramKey}</span>
                  <span className="text-indigo-400">
                    → {Number.isInteger(p.proposedValue) ? p.proposedValue : p.proposedValue.toFixed(4)}
                  </span>
                </div>
                <div className="flex items-center gap-1 text-[9px] font-mono">
                  <span className="text-emerald-400">+{forTotal.toFixed(2)}</span>
                  <span className="text-gray-600">/</span>
                  <span className="text-red-400">-{againstTotal.toFixed(2)}</span>
                  <span
                    className="ml-auto"
                    style={{ color: net >= 0 ? "#34d399" : "#f87171" }}
                  >
                    Δ {net >= 0 ? "+" : ""}{net.toFixed(2)}
                  </span>
                </div>
                <div className="flex gap-1">
                  <button
                    disabled={!canVote}
                    onClick={() => handleVote(p.id, true)}
                    className="flex-1 text-[9px] font-mono py-0.5 rounded border border-emerald-800 text-emerald-300 hover:bg-emerald-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    for
                  </button>
                  <button
                    disabled={!canVote}
                    onClick={() => handleVote(p.id, false)}
                    className="flex-1 text-[9px] font-mono py-0.5 rounded border border-red-800 text-red-300 hover:bg-red-950 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    against
                  </button>
                  <button
                    onClick={() => handleResolve(p.id)}
                    className="text-[9px] font-mono px-2 py-0.5 rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500 transition-colors"
                  >
                    resolve
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Recent history */}
      {historyTail.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-500 uppercase">
            Recent Decisions
          </span>
          {historyTail.map((h, i) => (
            <div
              key={i}
              className="flex items-center justify-between text-[9px] font-mono rounded border border-gray-800 bg-gray-950 px-2 py-0.5"
            >
              <span className="text-gray-400">{h.paramKey}</span>
              <span className="text-gray-300">
                {Number.isFinite(h.oldValue) ? h.oldValue.toFixed(4) : h.oldValue} →{" "}
                {Number.isFinite(h.newValue) ? h.newValue.toFixed(4) : h.newValue}
              </span>
              <span className="text-gray-600">ep {h.epoch}</span>
            </div>
          ))}
        </div>
      )}

      {!canVote && (
        <div className="text-[10px] font-mono text-gray-500 text-center">
          Build 100+ epochs of pool loyalty to earn voting weight.
        </div>
      )}
    </div>
  );
}
