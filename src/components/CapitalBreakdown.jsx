// Visualize how the same margin serves multiple roles (§10.1).
// Shows the trust balance, each tag's claim, and the free (un-tagged) portion.
import { TAG_KEYS, TAG_LABELS, TAG_COLORS, totalTagged } from "../lib/capitalTags.js";
import { HelpHint } from "./Tooltip.jsx";

export function CapitalBreakdown({ margin = 0, tags = {} }) {
  const total = Math.max(1, margin);
  const tagged = totalTagged(tags);
  const free = Math.max(0, margin - tagged);

  return (
    <div className="flex flex-col gap-2 p-2 rounded border border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-gray-400 flex items-center">
          Capital Roles
          <HelpHint
            width={280}
            text="Same-capital principle (§10.1): your margin is never transferred. Each 'tag' marks a portion of margin as simultaneously serving a role. Sum of tags ≤ margin; pool claims, auction losses, and contract obligations all settle against the same balance."
          />
        </span>
        <span className="text-[10px] font-mono text-gray-400">
          ${margin.toFixed(0)} total
        </span>
      </div>

      {/* Stacked bar of tags + free */}
      <div className="flex w-full h-3 rounded overflow-hidden bg-gray-900">
        {TAG_KEYS.map((k) => {
          const v = tags[k] ?? 0;
          if (v <= 0) return null;
          const pct = (v / total) * 100;
          return (
            <div
              key={k}
              style={{ width: `${pct}%`, background: TAG_COLORS[k] }}
              title={`${TAG_LABELS[k]}: $${v.toFixed(0)}`}
            />
          );
        })}
        <div
          style={{
            width: `${(free / total) * 100}%`,
            background: "#374151",
          }}
          title={`Free: $${free.toFixed(0)}`}
        />
      </div>

      {/* Per-tag rows */}
      <div className="grid grid-cols-2 gap-1 text-[9px] font-mono">
        {TAG_KEYS.map((k) => {
          const v = tags[k] ?? 0;
          return (
            <div key={k} className="flex items-center gap-1">
              <span
                className="w-1.5 h-1.5 rounded-full inline-block"
                style={{ background: TAG_COLORS[k] }}
              />
              <span className="text-gray-400 truncate">{TAG_LABELS[k]}</span>
              <span className="ml-auto text-gray-200">${v.toFixed(0)}</span>
            </div>
          );
        })}
        <div className="flex items-center gap-1 col-span-2 pt-1 border-t border-gray-800">
          <span className="w-1.5 h-1.5 rounded-full inline-block bg-gray-600" />
          <span className="text-gray-400">Free</span>
          <span className="ml-auto text-gray-300">${free.toFixed(0)}</span>
        </div>
      </div>
    </div>
  );
}
