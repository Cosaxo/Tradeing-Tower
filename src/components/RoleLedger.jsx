// Per-user role-return attribution (§4.10).
// Decomposes each epoch's margin delta into T-bill / Pool / Auction P&L /
// Tips / Contracts / Credit channels — the signal aggregate P&L collapses.
import { useMemo } from "react";
import { ROLES, ROLE_LABELS, ROLE_COLORS, epochTotal } from "../lib/roleLedger.js";
import { HelpHint } from "./Tooltip.jsx";
import { Sparkline } from "./Sparkline.jsx";

function StackedBar({ entry, width = 280, height = 24 }) {
  if (!entry) return null;
  const mags = ROLES.map((k) => ({ key: k, mag: Math.abs(entry[k] ?? 0) }));
  const total = mags.reduce((s, m) => s + m.mag, 0);
  if (total === 0) {
    return (
      <div
        className="text-[10px] font-mono text-gray-600 flex items-center justify-center rounded"
        style={{ width, height, background: "#111827" }}
      >
        no flow
      </div>
    );
  }
  let x = 0;
  return (
    <svg width={width} height={height} className="rounded overflow-hidden">
      {mags.map(({ key, mag }) => {
        if (mag === 0) return null;
        const w = (mag / total) * width;
        const el = (
          <rect
            key={key}
            x={x}
            y={0}
            width={w}
            height={height}
            fill={ROLE_COLORS[key]}
            opacity={(entry[key] ?? 0) >= 0 ? 1 : 0.55}
          />
        );
        x += w;
        return el;
      })}
    </svg>
  );
}

export function RoleLedger({ ledger, playerMargin = 5000 }) {
  const { cumulative = {}, lastEpoch, history = [] } = ledger ?? {};

  const lastTotal = epochTotal(lastEpoch);
  const cumulativeTotal = ROLES.reduce((s, k) => s + (cumulative[k] ?? 0), 0);

  // Build per-role sparkline data from history.
  const series = useMemo(
    () =>
      Object.fromEntries(
        ROLES.map((k) => [k, history.map((h) => h[k] ?? 0)])
      ),
    [history]
  );

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Role-Return Attribution
          <HelpHint
            width={300}
            text="Your margin delta each epoch decomposes into: T-bill (Floor 0), Pool yield (Floor 1, slow only), Auction P&L + Tips (Floor 2), Contracts (Floor 4), Credit Δ (Floor 3). Shows which role produces which chunk — aggregate P&L can't tell you that."
          />
        </span>
        <span className="text-[10px] font-mono text-gray-500">
          {history.length} epochs logged
        </span>
      </div>

      {/* Last-epoch stacked breakdown */}
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-[10px] font-mono text-gray-400">
          <span>Last epoch</span>
          <span style={{ color: lastTotal >= 0 ? "#34d399" : "#f87171" }}>
            {lastTotal >= 0 ? "+" : ""}${lastTotal.toFixed(3)}
          </span>
        </div>
        <StackedBar entry={lastEpoch} />
      </div>

      {/* Per-role rows */}
      <div className="flex flex-col gap-1">
        {ROLES.map((k) => {
          const cum = cumulative[k] ?? 0;
          const last = lastEpoch?.[k] ?? 0;
          return (
            <div
              key={k}
              className="grid grid-cols-[auto_1fr_auto_auto] gap-2 items-center rounded border border-gray-800 bg-gray-950 px-2 py-1"
            >
              <span
                className="w-2 h-2 rounded-full inline-block"
                style={{ background: ROLE_COLORS[k] }}
              />
              <span className="text-[10px] font-mono text-gray-300 truncate">
                {ROLE_LABELS[k]}
              </span>
              <Sparkline
                data={series[k]}
                width={60}
                height={16}
                color={ROLE_COLORS[k]}
                strokeWidth={1}
              />
              <div className="text-right">
                <div
                  className="text-[10px] font-mono"
                  style={{ color: last >= 0 ? "#d1d5db" : "#fca5a5" }}
                >
                  {last >= 0 ? "+" : ""}${last.toFixed(3)}
                </div>
                <div
                  className="text-[9px] font-mono"
                  style={{ color: cum >= 0 ? "#34d399" : "#f87171" }}
                >
                  Σ {cum >= 0 ? "+" : ""}${cum.toFixed(2)}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer: cumulative identity check */}
      <div className="text-[10px] font-mono text-gray-500 flex justify-between pt-1 border-t border-gray-800">
        <span>Cumulative Δmargin</span>
        <span style={{ color: cumulativeTotal >= 0 ? "#34d399" : "#f87171" }}>
          {cumulativeTotal >= 0 ? "+" : ""}${cumulativeTotal.toFixed(2)}
        </span>
      </div>
      <div className="text-[9px] font-mono text-gray-600 text-center">
        current margin ${playerMargin.toFixed(0)}
      </div>
    </div>
  );
}
