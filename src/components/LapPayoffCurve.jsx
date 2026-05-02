// Per-position payoff curve. Renders the user's $ P&L as a function
// of the underlying price move, using the same exp-form math as the
// actual position close. Three modes:
//
//   - single LAP:    directional curve, asymmetric; capped at -margin
//   - paired LAP:    gamma curve (cosh-based), always non-negative
//   - bbook contract: same shape as single LAP — but labelled to make
//                     the routing visible to the user (transparency).
//
// Designed to be small enough to embed inline next to a position card.
import { useMemo } from "react";
import { HelpHint } from "./Tooltip.jsx";
import { isPairedLap } from "../lib/pairedLap.js";

const W = 280;
const H = 100;
const PAD = { left: 32, right: 8, top: 8, bottom: 22 };
const IW = W - PAD.left - PAD.right;
const IH = H - PAD.top - PAD.bottom;

// Sample at moves from -50% to +50% in 1% steps.
const SAMPLES = 101;
const MIN_PCT = -0.5;
const MAX_PCT = 0.5;

function singlePnl(margin, leverage, side, pct) {
  const direction = side === "LONG" ? 1 : -1;
  const logRet = Math.log(1 + pct);
  const raw = margin * leverage * (Math.exp(direction * logRet) - 1);
  return Math.max(-margin, raw);
}

function pairedPnl(totalMargin, leverage, pct) {
  const legMargin = totalMargin / 2;
  const logRet = Math.log(1 + pct);
  const longLeg = legMargin * leverage * (Math.exp(logRet) - 1);
  const shortLeg = legMargin * leverage * (Math.exp(-logRet) - 1);
  return longLeg + shortLeg;
}

export function LapPayoffCurve({ position, currentPrice = null, label = null }) {
  const { samples, yMin, yMax, paired, side, leverage, margin } = useMemo(() => {
    if (!position) {
      return { samples: [], yMin: 0, yMax: 0, paired: false, side: "LONG", leverage: 0, margin: 0 };
    }
    const paired = isPairedLap(position) || position.type === "paired";
    const margin = position.margin ?? 0;
    const leverage = position.leverage ?? 1;
    const side = position.side ?? "LONG";

    const samples = [];
    let yMin = 0;
    let yMax = 0;
    for (let i = 0; i < SAMPLES; i++) {
      const t = i / (SAMPLES - 1);
      const pct = MIN_PCT + t * (MAX_PCT - MIN_PCT);
      const pnl = paired
        ? pairedPnl(margin, leverage, pct)
        : singlePnl(margin, leverage, side, pct);
      samples.push({ pct, pnl });
      if (pnl < yMin) yMin = pnl;
      if (pnl > yMax) yMax = pnl;
    }
    // Always show 0 on the y-axis.
    yMin = Math.min(yMin, 0);
    yMax = Math.max(yMax, 0);
    return { samples, yMin, yMax, paired, side, leverage, margin };
  }, [position]);

  if (!position || samples.length === 0) return null;

  const yRange = Math.max(1e-6, yMax - yMin);
  const xRange = MAX_PCT - MIN_PCT;
  const x = (pct) => PAD.left + ((pct - MIN_PCT) / xRange) * IW;
  const y = (pnl) => PAD.top + IH - ((pnl - yMin) / yRange) * IH;
  const zeroY = y(0);
  const zeroX = x(0);

  const points = samples
    .map((s) => `${x(s.pct).toFixed(1)},${y(s.pnl).toFixed(1)}`)
    .join(" ");

  // Optional: marker for current price's implied move.
  let liveMarker = null;
  if (currentPrice && position.openPrice) {
    const livePct = currentPrice / position.openPrice - 1;
    if (livePct >= MIN_PCT && livePct <= MAX_PCT) {
      const livePnl = paired
        ? pairedPnl(margin, leverage, livePct)
        : singlePnl(margin, leverage, side, livePct);
      liveMarker = { pct: livePct, pnl: livePnl };
    }
  }

  const stroke = paired ? "#a78bfa" : side === "LONG" ? "#34d399" : "#f87171";
  const fillFloor = paired ? "rgba(167, 139, 250, 0.08)" : side === "LONG" ? "rgba(52, 211, 153, 0.08)" : "rgba(248, 113, 113, 0.08)";

  // Tick marks at -25%, 0, +25%.
  const xTicks = [-0.5, -0.25, 0, 0.25, 0.5];

  return (
    <div className="rounded bg-gray-900 border border-gray-700 p-2">
      <div className="flex items-center gap-2 mb-1 px-1 text-xs font-mono text-gray-400">
        <span className="flex items-center">
          {label ?? (paired ? "Paired LAP gamma" : `${side} payoff curve`)}
          <HelpHint
            width={300}
            text={
              paired
                ? "Net P&L = m·L·(cosh(r)−1) where r = ln(price_now/price_open). Always ≥ 0; grows with volatility (positive gamma)."
                : "P&L = m·L·(exp(±r)−1). Continuous-compounding leverage caps loss at margin (no liquidation needed) and uplifts gains super-linearly."
            }
          />
        </span>
        <span className="ml-auto text-gray-600">
          ${margin.toFixed(0)} × {leverage.toFixed(1)}×
        </span>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Y=0 baseline */}
        <line
          x1={PAD.left}
          x2={PAD.left + IW}
          y1={zeroY}
          y2={zeroY}
          stroke="#374151"
          strokeWidth={0.5}
          strokeDasharray="2 2"
        />
        {/* X=0 baseline (open price) */}
        <line
          x1={zeroX}
          x2={zeroX}
          y1={PAD.top}
          y2={PAD.top + IH}
          stroke="#374151"
          strokeWidth={0.5}
          strokeDasharray="2 2"
        />
        {/* Curve fill */}
        <polyline
          points={`${PAD.left.toFixed(1)},${zeroY.toFixed(1)} ${points} ${(PAD.left + IW).toFixed(1)},${zeroY.toFixed(1)}`}
          fill={fillFloor}
          stroke="none"
        />
        {/* Curve */}
        <polyline points={points} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
        {/* Live marker */}
        {liveMarker && (
          <>
            <circle cx={x(liveMarker.pct)} cy={y(liveMarker.pnl)} r={3} fill={stroke} />
            <text
              x={Math.min(PAD.left + IW - 28, Math.max(PAD.left + 4, x(liveMarker.pct) + 4))}
              y={y(liveMarker.pnl) - 4}
              fill={stroke}
              fontSize={8}
              fontFamily="monospace"
            >
              {liveMarker.pnl >= 0 ? "+" : ""}${liveMarker.pnl.toFixed(0)}
            </text>
          </>
        )}
        {/* X ticks */}
        {xTicks.map((t, i) => (
          <text
            key={i}
            x={x(t)}
            y={H - 8}
            textAnchor="middle"
            fill="#6b7280"
            fontSize={7}
            fontFamily="monospace"
          >
            {t === 0 ? "open" : `${t > 0 ? "+" : ""}${(t * 100).toFixed(0)}%`}
          </text>
        ))}
        {/* Y axis: max gain + max loss labels */}
        <text x={PAD.left - 4} y={PAD.top + 6} textAnchor="end" fill="#9ca3af" fontSize={7} fontFamily="monospace">
          +${yMax.toFixed(0)}
        </text>
        <text x={PAD.left - 4} y={PAD.top + IH - 1} textAnchor="end" fill="#9ca3af" fontSize={7} fontFamily="monospace">
          ${yMin.toFixed(0)}
        </text>
      </svg>
    </div>
  );
}
