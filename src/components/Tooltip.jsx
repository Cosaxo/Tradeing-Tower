import { useState } from "react";

// Lightweight hover tooltip — useful for explaining jargon like
// "geodesic distribution" or "entropy multiplier".
export function Tooltip({ text, children, width = 200 }) {
  const [open, setOpen] = useState(false);

  return (
    <span className="relative inline-flex items-center"
          onMouseEnter={() => setOpen(true)}
          onMouseLeave={() => setOpen(false)}
    >
      {children}
      {open && (
        <span
          className="absolute z-40 bottom-full left-1/2 -translate-x-1/2 mb-1 px-2 py-1 rounded bg-gray-800 border border-gray-700 text-[10px] font-mono text-gray-200 shadow-lg"
          style={{ width, whiteSpace: "normal" }}
        >
          {text}
        </span>
      )}
    </span>
  );
}

// Pre-canned help bubble (ⓘ) that shows a tooltip on hover.
export function HelpHint({ text, width = 240 }) {
  return (
    <Tooltip text={text} width={width}>
      <span
        className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-gray-600 text-[10px] font-mono text-gray-400 ml-1 cursor-help select-none hover:border-indigo-500 hover:text-indigo-300 transition-colors"
        role="img"
        aria-label={`Help: ${typeof text === "string" ? text.slice(0, 120) : ""}`}
      >
        ?
      </span>
    </Tooltip>
  );
}
