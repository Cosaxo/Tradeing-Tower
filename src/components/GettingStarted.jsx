// Getting-Started hint — shows the user where they are in the
// pool→credit→LAP→FLOAT flow when they haven't progressed past it.
//
// Auto-collapses (becomes a small "show steps" link) once they have
// at least one allocation, one open position, and one mint. Always
// dismissable so it never feels in the way.

import { useState } from "react";

export function GettingStarted({
  hasAllocation,
  hasPosition,
  hasMinted,
  hasMerchantSent,
  activeTab,
  onJump,
}) {
  const [collapsed, setCollapsed] = useState(false);

  const steps = [
    {
      key: "allocate",
      tab: "Insurance",
      title: "1. Allocate margin to insurance markets",
      desc: "On the Insurance tab, set sliders to spread your margin across event markets. Diversification lifts your LTV.",
      done: hasAllocation,
    },
    {
      key: "position",
      tab: "Trade",
      title: "2. Open a position (optional)",
      desc: "On the Trade tab, open a single or paired LAP. Pool credit funds it; LAP P&L flows back into your allocation.",
      done: hasPosition,
    },
    {
      key: "mint",
      tab: "FLOAT",
      title: "3. Mint Float (FLOAT)",
      desc: "On the FLOAT tab. Once your LTV is high enough (≥ 0.6), mint FLOAT against your allocation. Reinsurance is auto-bought to cover you.",
      done: hasMinted,
    },
    {
      key: "spend",
      tab: "FLOAT",
      title: "4. Send FLOAT to a merchant",
      desc: "Simulates real-world payment. The merchant queues redemption; you watch your collateral drain pro-rata each cycle.",
      done: hasMerchantSent,
    },
  ];

  const allDone = steps.every((s) => s.done);
  const nextStep = steps.find((s) => !s.done);

  if (allDone) return null;
  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        className="text-[10px] font-mono text-indigo-400 hover:text-indigo-200 px-2 py-1 rounded border border-indigo-900 bg-indigo-950/40 hover:bg-indigo-950 self-start"
      >
        ? Show getting-started steps ({steps.filter((s) => s.done).length}/{steps.length} done)
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-1 p-3 rounded border border-indigo-800 bg-indigo-950/20">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-indigo-200">Getting started</span>
        <button
          onClick={() => setCollapsed(true)}
          className="text-[10px] font-mono text-gray-500 hover:text-gray-200 px-2"
          aria-label="Collapse"
        >
          collapse
        </button>
      </div>
      <div className="text-[10px] font-mono text-gray-400">
        Welcome — your capital flows through these layers. Each step
        unlocks the next; you can press <strong className="text-gray-200">Space</strong> to start the
        market simulation at any time.
      </div>
      <div className="flex flex-col gap-1 mt-1">
        {steps.map((s, i) => {
          const isNext = !s.done && nextStep?.key === s.key;
          return (
            <div
              key={s.key}
              className={`flex items-start gap-2 text-[10px] font-mono px-2 py-1 rounded border ${
                s.done
                  ? "border-emerald-900 bg-emerald-950/30 text-emerald-300"
                  : isNext
                    ? "border-indigo-700 bg-indigo-950/60 text-indigo-100"
                    : "border-gray-800 text-gray-500"
              }`}
            >
              <span className="w-3 text-center">
                {s.done ? "✓" : isNext ? "▶" : i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="font-bold">{s.title}</div>
                <div className="text-gray-500 mt-0.5">{s.desc}</div>
              </div>
              {!s.done && activeTab !== s.tab && (
                <button
                  onClick={() => onJump?.(s.tab)}
                  className="text-[10px] font-mono text-indigo-300 hover:text-indigo-100 underline px-1 self-center"
                >
                  → {s.tab}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
