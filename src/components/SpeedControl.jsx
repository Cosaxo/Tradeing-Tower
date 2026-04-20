// Simulation speed multiplier. Shortens the interval periods in useEpochLoop.
const SPEEDS = [
  { label: "½×", value: 0.5 },
  { label: "1×", value: 1 },
  { label: "2×", value: 2 },
  { label: "5×", value: 5 },
];

export function SpeedControl({ speed, onSpeed }) {
  return (
    <div className="flex items-center gap-1">
      <span className="text-[10px] font-mono text-gray-500">speed</span>
      {SPEEDS.map((s) => (
        <button
          key={s.value}
          onClick={() => onSpeed(s.value)}
          className={`text-[10px] font-mono px-2 py-0.5 rounded transition-colors ${
            speed === s.value
              ? "bg-indigo-900 text-indigo-200"
              : "bg-gray-800 text-gray-400 hover:text-gray-200"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
