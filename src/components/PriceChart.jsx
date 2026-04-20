// Full-size price chart with regime colour band.
import { useMemo } from "react";

const CHART_H = 120;
const PADDING = { left: 40, right: 8, top: 8, bottom: 16 };

const EVENT_COLOR = {
  liquidation: "#f87171",
  regime: "#60a5fa",
  softClose: "#fbbf24",
};

export function PriceChart({ prices = [], regime = null, width = 400, pair = null, events = [], currentEpoch = 0 }) {
  const chartW = width - PADDING.left - PADDING.right;
  const chartH = CHART_H - PADDING.top - PADDING.bottom;

  const { polyline, yTicks, latestPrice, pct } = useMemo(() => {
    if (prices.length < 2) return { polyline: "", yTicks: [], latestPrice: null, pct: 0 };

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const range = max - min || 1;

    const xs = prices.map((_, i) => PADDING.left + (i / (prices.length - 1)) * chartW);
    const ys = prices.map(
      (v) => PADDING.top + chartH - ((v - min) / range) * chartH
    );

    const polyline = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");

    const steps = 4;
    const yTicks = Array.from({ length: steps + 1 }, (_, i) => {
      const val = min + (range * i) / steps;
      const y = PADDING.top + chartH - (i / steps) * chartH;
      return { val, y };
    });

    const latestPrice = prices[prices.length - 1];
    const firstPrice = prices[0];
    const pct = ((latestPrice - firstPrice) / firstPrice) * 100;

    return { polyline, yTicks, latestPrice, pct };
  }, [prices, chartW, chartH]);

  const regimeColor = regime?.color ?? "#374151";
  const lineColor = pct >= 0 ? "#34d399" : "#f87171";

  return (
    <div className="rounded bg-gray-900 border border-gray-700 p-2">
      <div className="flex items-baseline justify-between mb-1 px-1">
        <span className="text-xs font-mono text-gray-300">{pair?.symbol ?? ""}</span>
        {latestPrice != null && (
          <span className="text-xs font-mono" style={{ color: lineColor }}>
            {latestPrice < 10
              ? latestPrice.toFixed(4)
              : latestPrice < 1000
              ? latestPrice.toFixed(2)
              : latestPrice.toFixed(0)}
            {" "}
            <span className="text-gray-500">
              ({pct >= 0 ? "+" : ""}{pct.toFixed(2)}%)
            </span>
          </span>
        )}
        {regime && (
          <span
            className="text-xs px-1.5 py-0.5 rounded font-mono"
            style={{ background: regimeColor + "33", color: regimeColor }}
          >
            {regime.label}
          </span>
        )}
      </div>
      <svg width="100%" height={CHART_H} viewBox={`0 0 ${width} ${CHART_H}`}>
        {/* Y-axis ticks */}
        {yTicks.map(({ val, y }, i) => (
          <g key={i}>
            <line
              x1={PADDING.left}
              x2={PADDING.left + chartW}
              y1={y}
              y2={y}
              stroke="#374151"
              strokeWidth={0.5}
              strokeDasharray="3,3"
            />
            <text
              x={PADDING.left - 4}
              y={y + 3}
              textAnchor="end"
              fill="#6b7280"
              fontSize={8}
              fontFamily="monospace"
            >
              {val < 10 ? val.toFixed(3) : val < 1000 ? val.toFixed(1) : (val / 1000).toFixed(1) + "k"}
            </text>
          </g>
        ))}
        {/* Price line */}
        {polyline && (
          <polyline
            points={polyline}
            fill="none"
            stroke={lineColor}
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        )}
        {/* Event annotations */}
        {events.length > 0 && prices.length > 1 && (() => {
          // Map event.epoch → x position in chart.
          const firstEpoch = Math.max(0, currentEpoch - prices.length + 1);
          return events
            .filter((e) => e.epoch >= firstEpoch && e.epoch <= currentEpoch)
            .map((e, i) => {
              const relIdx = e.epoch - firstEpoch;
              const x =
                PADDING.left + (relIdx / (prices.length - 1)) * chartW;
              const color = EVENT_COLOR[e.type] ?? "#9ca3af";
              return (
                <g key={`${e.epoch}-${e.type}-${i}`}>
                  <line
                    x1={x}
                    x2={x}
                    y1={PADDING.top}
                    y2={CHART_H - PADDING.bottom}
                    stroke={color}
                    strokeWidth={0.75}
                    strokeDasharray="2,2"
                    opacity={0.7}
                  />
                  <circle cx={x} cy={PADDING.top + 2} r={2} fill={color} />
                </g>
              );
            });
        })()}
      </svg>
    </div>
  );
}
