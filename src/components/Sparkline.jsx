// Inline SVG sparkline for price history.
export function Sparkline({ data = [], width = 80, height = 24, color = "#34d399", strokeWidth = 1.5 }) {
  if (!data || data.length < 2) return <svg width={width} height={height} />;

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const xs = data.map((_, i) => (i / (data.length - 1)) * width);
  const ys = data.map((v) => height - ((v - min) / range) * (height - 2) - 1);

  const points = xs.map((x, i) => `${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
