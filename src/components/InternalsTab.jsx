// Internals tab — single dumping ground for power-user / debug content.
//
// Phase 1 of the UI roadmap moves the following from peer-level tabs
// into a single "Internals" tab:
//   - Stress: solvency buffer + Monte Carlo harness
//   - Markets: regime timeline, fee flow, correlation heatmap
//   - History: closed-trade ledger
//   - Log: live epoch log
//   - Performance: equity-curve metrics, role-attribution ledger
//   - Peers: connected room participants
//
// Each section is collapsible so the page doesn't become a wall of
// dense panels by default. Phase 3 of the roadmap turns this into a
// slide-out drawer with the same content; Phase 1 is the lift-and-
// shift first so the main tab list shrinks immediately.

import { useState } from "react";
import { StressPanel } from "./StressPanel.jsx";
import { StressHarnessPanel } from "./StressHarnessPanel.jsx";
import { RegimeTimeline } from "./RegimeTimeline.jsx";
import { FeeFlow } from "./FeeFlow.jsx";
import { CorrelationHeatmap } from "./CorrelationHeatmap.jsx";
import { TradeHistory } from "./TradeHistory.jsx";
import { LogicView } from "./LogicView.jsx";
import { MetricsPanel } from "./MetricsPanel.jsx";
import { RoleLedger } from "./RoleLedger.jsx";
import { PeersPanel } from "./PeersPanel.jsx";

function Section({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded border border-gray-800 bg-gray-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3 py-2 text-[11px] font-mono text-gray-300 hover:bg-gray-900 rounded-t"
      >
        <span>{title}</span>
        <span className="text-gray-500">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <div className="p-3 flex flex-col gap-2 border-t border-gray-800">
          {children}
        </div>
      )}
    </div>
  );
}

export function InternalsTab({
  // Stress
  solvency,
  shockResults,
  onRunShock,
  // Markets
  regimeHistory,
  currentRegime,
  currentEpoch,
  feeLedger,
  correlationMap,
  pairs,
  // History
  trades,
  // Log
  logs,
  // Performance
  equityHistory,
  roleLedger,
  playerMargin,
  // Peers
  peers,
  peerCount,
  roomId,
}) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[10px] font-mono text-gray-500 leading-relaxed border border-gray-800 bg-gray-950 rounded px-2 py-1.5">
        Internals — power-user diagnostics. Click each section to expand.
        Nothing here is required to use the protocol; it's exposed for
        people debugging behavior or auditing protocol invariants.
      </p>

      <Section title="Performance · equity curve, attribution" defaultOpen>
        <MetricsPanel equityHistory={equityHistory} />
        <RoleLedger ledger={roleLedger} playerMargin={playerMargin ?? 0} />
      </Section>

      <Section title="Stress · solvency buffer, Monte Carlo harness">
        <StressPanel
          solvency={solvency}
          shockResults={shockResults}
          onRunShock={onRunShock}
        />
        <StressHarnessPanel />
      </Section>

      <Section title="Markets · regime timeline, fee flow, cross-pair correlation">
        <RegimeTimeline
          history={regimeHistory ?? []}
          currentRegime={currentRegime}
          currentEpoch={currentEpoch ?? 0}
        />
        <FeeFlow ledger={feeLedger} />
        <CorrelationHeatmap
          corrMap={correlationMap ?? {}}
          pairs={pairs ?? []}
        />
      </Section>

      <Section title="History · closed trades">
        <TradeHistory trades={trades ?? []} />
      </Section>

      <Section title="Log · live epoch stream">
        <div
          className="rounded border border-gray-800 bg-gray-900"
          style={{ minHeight: "300px" }}
        >
          <LogicView logs={logs ?? []} />
        </div>
      </Section>

      <Section title="Peers · room participants">
        <PeersPanel
          peers={peers ?? []}
          peerCount={peerCount ?? 0}
          roomId={roomId ?? "default"}
        />
      </Section>
    </div>
  );
}
