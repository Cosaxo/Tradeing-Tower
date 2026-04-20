// SVG visualization of the geodesic leverage distribution.
// Renders long (green) and short (red) ideal/actual curves side-by-side.
import { useMemo } from "react";
import { HelpHint } from "./Tooltip.jsx";

const W = 280;
const H = 90;
const PAD = { left: 30, right: 8, top: 6, bottom: 18 };
const IW = W - PAD.left - PAD.right;
const IH = H - PAD.top - PAD.bottom;

function curvePolyline(buckets, field, color, maxVal) {
  if (!buckets || buckets.length < 2) return null;
  const pts = buckets.map((b, i) => {
    const x = PAD.left + (i / (buckets.length - 1)) * IW;
    const y = PAD.top + IH - (b[field] / Math.max(1e-8, maxVal)) * IH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <polyline
      key={field + color}
      points={pts.join(" ")}
      fill="none"
      stroke={color}
      strokeWidth={1.5}
      strokeLinejoin="round"
    />
  );
}

export function LeverageCurve({ longCurve = [], shortCurve = [], cap = 2 }) {
  const { maxIdeal, xTicks } = useMemo(() => {
    const allIdeal = [...longCurve, ...shortCurve].map((b) => b.ideal ?? 0);
    const maxIdeal = Math.max(1e-8, ...allIdeal);

    const bucketLevs = (longCurve.length > 0 ? longCurve : shortCurve).map((b) => b.lev ?? 0);
    const step = Math.ceil(bucketLevs.length / 5);
    const xTicks = bucketLevs
      .filter((_, i) => i % step === 0 || i === bucketLevs.length - 1)
      .map((lev, idx) => ({
        lev,
        x: PAD.left + ((idx * step) / Math.max(1, bucketLevs.length - 1)) * IW,
      }));

    return { maxIdeal, xTicks };
  }, [longCurve, shortCurve]);

  return (
    <div className="rounded bg-gray-900 border border-gray-700 p-2">
      <div className="flex items-center gap-3 mb-1 px-1 text-xs font-mono text-gray-400">
        <span className="flex items-center">
          Geodesic Distribution
          <HelpHint text="Bimodal log-normal in log-leverage space: one mode for conservative traders (low lev), one for speculators (high lev). Meta-parameters adapt each epoch via KL-gradient descent so ideal (faint) tracks actual (solid)." />
        </span>
        <span className="ml-auto text-gray-600">cap {cap.toFixed(1)}×</span>
      </div>
      <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`}>
        {/* Grid */}
        {[0.25, 0.5, 0.75, 1].map((t) => {
          const y = PAD.top + IH * (1 - t);
          return (
            <line
              key={t}
              x1={PAD.left}
              x2={PAD.left + IW}
              y1={y}
              y2={y}
              stroke="#1f2937"
              strokeWidth={0.5}
            />
          );
        })}
        {/* Curves: ideal (dashed) and actual (solid) */}
        {curvePolyline(longCurve, "ideal", "#34d39966", maxIdeal)}
        {curvePolyline(longCurve, "actual", "#34d399", maxIdeal)}
        {curvePolyline(shortCurve, "ideal", "#f8717166", maxIdeal)}
        {curvePolyline(shortCurve, "actual", "#f87171", maxIdeal)}
        {/* X-axis leverage ticks */}
        {xTicks.map(({ lev, x }, i) => (
          <text key={i} x={x} y={H - 2} textAnchor="middle" fill="#6b7280" fontSize={7} fontFamily="monospace">
            {lev.toFixed(1)}×
          </text>
        ))}
        {/* Legend */}
        <text x={PAD.left + 2} y={PAD.top + 8} fill="#34d399" fontSize={7} fontFamily="monospace">L</text>
        <text x={PAD.left + 12} y={PAD.top + 8} fill="#f87171" fontSize={7} fontFamily="monospace">S</text>
        <text x={PAD.left + 22} y={PAD.top + 8} fill="#6b7280" fontSize={7} fontFamily="monospace">─ideal ──actual</text>
      </svg>
    </div>
  );
}
