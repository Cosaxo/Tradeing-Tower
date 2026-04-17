// Live log stream: shows the last N epoch log entries in a scrollable box.
import { useEffect, useRef } from "react";

const TYPE_COLOR = {
  AUCTION: "#818cf8",
  MATCH: "#34d399",
  POOL: "#fbbf24",
  POOL_CLAIM: "#f87171",
  "POOL SLOW": "#a78bfa",
  STRIPS: "#60a5fa",
  "IMBAL CONTRACT": "#fb923c",
  "ENT CONTRACT": "#e879f9",
  REGIME: "#2dd4bf",
};

function tagColor(line) {
  for (const [tag, color] of Object.entries(TYPE_COLOR)) {
    if (line.includes(`[${tag}]`)) return color;
  }
  return "#6b7280";
}

export function LogicView({ logs = [], maxLines = 80 }) {
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [logs]);

  const visible = logs.slice(-maxLines);

  return (
    <div className="flex flex-col h-full">
      <div className="text-[10px] font-mono text-gray-500 px-2 py-1 border-b border-gray-800">
        Epoch Log ({logs.length} entries)
      </div>
      <div className="flex-1 overflow-y-auto px-2 py-1 font-mono text-[10px] leading-4">
        {visible.map((line, i) => (
          <div key={i} style={{ color: tagColor(line) }}>
            {line}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
