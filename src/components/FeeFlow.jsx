// Fee-routing visualization: inbound fee streams → outbound destinations.
// Renders a simple 2-column flow (sources → destinations) plus a cumulative
// summary table.
import { HelpHint } from "./Tooltip.jsx";

const COLORS = {
  stabilityFee: "#fbbf24",
  stripPremium: "#60a5fa",
  routedToBuffer: "#a78bfa",
  routedToPool: "#60a5fa",
  routedToDepositors: "#34d399",
  claimsPaid: "#f87171",
  bufferDraws: "#e879f9",
};

const SRC_LABELS = {
  stabilityFee: "Stability Fee",
  stripPremium: "Strip Premium",
};

const DST_LABELS = {
  routedToBuffer: "Yield Buffer",
  routedToPool: "Insurance Pool",
  routedToDepositors: "Depositors",
  claimsPaid: "Claims Paid",
  bufferDraws: "Buffer Drawn",
};

// Last-epoch flow as a 2-column Sankey-style diagram.
function FlowDiagram({ flow }) {
  if (!flow) return null;

  const sources = Object.entries(SRC_LABELS).map(([k, label]) => ({
    key: k,
    label,
    value: flow[k] ?? 0,
  }));
  const destinations = Object.entries(DST_LABELS).map(([k, label]) => ({
    key: k,
    label,
    value: flow[k] ?? 0,
  }));

  const maxSource = Math.max(1e-6, ...sources.map((s) => s.value));
  const maxDest = Math.max(1e-6, ...destinations.map((d) => d.value));

  const W = 260;
  const H = 140;
  const COL = W / 3;
  const PAD = 8;

  // Evenly space source + destination bars vertically.
  function placeBars(items, max, xStart) {
    const rowH = (H - 2 * PAD) / items.length;
    return items.map((it, i) => {
      const y = PAD + i * rowH + 2;
      const h = rowH - 6;
      const barW = (it.value / max) * (COL - PAD - 4);
      return { ...it, y, h, x: xStart, w: Math.max(1, barW) };
    });
  }

  const srcBars = placeBars(sources, maxSource, PAD);
  const dstBars = placeBars(destinations, maxDest, W - PAD - (COL - PAD - 4));

  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} className="font-mono">
      {srcBars.map((b) => (
        <g key={b.key}>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={COLORS[b.key] ?? "#9ca3af"}
            rx={1}
          />
          <text
            x={b.x + b.w + 2}
            y={b.y + b.h / 2 + 2}
            fontSize={7}
            fill="#cbd5e1"
          >
            {b.label} ${b.value.toFixed(1)}
          </text>
        </g>
      ))}
      {dstBars.map((b) => (
        <g key={b.key}>
          <rect
            x={b.x}
            y={b.y}
            width={b.w}
            height={b.h}
            fill={COLORS[b.key] ?? "#9ca3af"}
            rx={1}
          />
          <text
            x={b.x - 2}
            y={b.y + b.h / 2 + 2}
            fontSize={7}
            fill="#cbd5e1"
            textAnchor="end"
          >
            {b.label} ${b.value.toFixed(1)}
          </text>
        </g>
      ))}
      {/* Connecting lines from source stack center to destination stack center */}
      {srcBars.map((s, i) =>
        dstBars.map((d, j) => (
          <line
            key={`${i}-${j}`}
            x1={s.x + s.w}
            y1={s.y + s.h / 2}
            x2={d.x}
            y2={d.y + d.h / 2}
            stroke="#374151"
            strokeWidth={0.3}
            opacity={0.5}
          />
        ))
      )}
    </svg>
  );
}

export function FeeFlow({ ledger }) {
  if (!ledger) return null;

  const rows = [
    { label: "Stability fee collected", key: "stabilityFee", color: COLORS.stabilityFee },
    { label: "Strip premiums", key: "stripPremium", color: COLORS.stripPremium },
    { label: "Routed to buffer", key: "routedToBuffer", color: COLORS.routedToBuffer },
    { label: "Routed to pool", key: "routedToPool", color: COLORS.routedToPool },
    { label: "Paid to depositors", key: "routedToDepositors", color: COLORS.routedToDepositors },
    { label: "Claims paid", key: "claimsPaid", color: COLORS.claimsPaid },
    { label: "Buffer draws", key: "bufferDraws", color: COLORS.bufferDraws },
  ];

  const totalIn = (ledger.stabilityFee ?? 0) + (ledger.stripPremium ?? 0);
  const totalOut = (ledger.routedToDepositors ?? 0) + (ledger.claimsPaid ?? 0);

  return (
    <div className="flex flex-col gap-2 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Fee Flow
          <HelpHint text="Per-pair fee accounting. The cumulative `stabilityFee` is deducted from auction tip revenue each medium epoch. Pre-Phase-5 routing (pool premiums, claims, yield buffer) was removed — only the stability-fee tally remains." />
        </span>
        <span className="text-[10px] font-mono text-gray-500">
          last epoch
        </span>
      </div>

      <FlowDiagram flow={ledger.lastEpoch} />

      <div className="text-[10px] font-mono text-gray-400 flex justify-between pb-1 border-b border-gray-800">
        <span>Inflows total</span>
        <span className="text-emerald-400">${totalIn.toFixed(2)}</span>
      </div>
      <div className="text-[10px] font-mono text-gray-400 flex justify-between pb-1 border-b border-gray-800">
        <span>Outflows total</span>
        <span className="text-red-400">${totalOut.toFixed(2)}</span>
      </div>

      <div className="grid grid-cols-2 gap-1">
        {rows.map(({ label, key, color }) => (
          <div
            key={key}
            className="flex items-center justify-between rounded border border-gray-800 bg-gray-950 px-2 py-1"
          >
            <div className="flex items-center gap-1 min-w-0">
              <span
                className="w-1.5 h-1.5 rounded-full inline-block shrink-0"
                style={{ background: color }}
              />
              <span className="text-[9px] font-mono text-gray-400 truncate">
                {label}
              </span>
            </div>
            <span className="text-[9px] font-mono text-gray-200">
              ${(ledger[key] ?? 0).toFixed(2)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
