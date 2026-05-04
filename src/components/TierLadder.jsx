// TierLadder — visualises the four-tier capital ladder.
//
// Capital climbs the ladder. Each rung adds an uncorrelated yield
// source on top of the previous rungs. Locked rungs show the gate
// requirement and (when relevant) a concrete next step.
//
// Tier 1: T-bill principal               — automatic, always unlocked
// Tier 2: Insurance-seller stake         — automatic
// Tier 3: LAP active-trade access        — gate: ≥3 markets, max 50% any single, reinsurance bought
// Tier 4: FLOAT mint (full thread)          — gate: layer-3 role is B-book stake (per-thread)
//
// `principal` is the user's free + tagged margin total in dollars.
// `currentTier` is computed from gate evaluation (the highest unlocked
// tier the user is currently exercising). Tiers above currentTier are
// rendered as locked / aspirational.

const TIER_INFO = [
  {
    n: 1,
    label: "T-bill",
    sub: "Principal — the dollar itself",
    color: "from-emerald-700 to-emerald-900",
    border: "border-emerald-700",
    ring: "ring-emerald-500",
  },
  {
    n: 2,
    label: "Insurance",
    sub: "Premium income across event markets",
    color: "from-sky-700 to-sky-900",
    border: "border-sky-700",
    ring: "ring-sky-500",
  },
  {
    n: 3,
    label: "LAP / Trade",
    sub: "Active leveraged auction exposure",
    color: "from-amber-700 to-amber-900",
    border: "border-amber-700",
    ring: "ring-amber-500",
  },
  {
    n: 4,
    label: "FLOAT Mint",
    sub: "$1 plays all 4 roles · stablecoin",
    color: "from-violet-700 to-violet-900",
    border: "border-violet-700",
    ring: "ring-violet-500",
  },
];

export function TierLadder({
  currentTier = 1,
  principal = 0,
  gates = {}, // { 3: { unlocked, missing: [...] }, 4: { unlocked, missing: [...] } }
  onJumpToAdvanced,
  variant = "full", // "full" | "compact"
}) {
  const compact = variant === "compact";

  return (
    <div className="flex flex-col gap-2">
      {!compact && (
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-mono text-gray-200">Your capital ladder</h3>
          {principal > 0 && (
            <span className="text-[10px] font-mono text-gray-500">
              ${principal.toFixed(0)} climbing all unlocked tiers
            </span>
          )}
        </div>
      )}

      <div
        className={`grid gap-1.5 ${
          compact ? "grid-cols-4" : "grid-cols-1 md:grid-cols-4"
        }`}
      >
        {TIER_INFO.map((t) => {
          const isActive = t.n <= currentTier;
          const gate = gates[t.n];
          const isLocked = !isActive && gate && !gate.unlocked;
          const isReady = !isActive && gate && gate.unlocked;

          return (
            <div
              key={t.n}
              className={`relative rounded border ${t.border} p-2 flex flex-col gap-1 ${
                isActive
                  ? `bg-gradient-to-br ${t.color} ring-1 ${t.ring}`
                  : isReady
                    ? "bg-gray-900 border-dashed"
                    : "bg-gray-950 opacity-60"
              }`}
              title={t.sub}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[10px] font-mono ${
                    isActive ? "text-white/90" : "text-gray-400"
                  }`}
                >
                  Tier {t.n}
                </span>
                <span
                  className={`text-[10px] font-mono ${
                    isActive
                      ? "text-emerald-300"
                      : isReady
                        ? "text-amber-300"
                        : "text-gray-600"
                  }`}
                >
                  {isActive ? "ON" : isReady ? "READY" : "LOCKED"}
                </span>
              </div>
              <div
                className={`text-xs font-mono font-bold ${
                  isActive ? "text-white" : "text-gray-300"
                }`}
              >
                {t.label}
              </div>
              {!compact && (
                <div
                  className={`text-[10px] font-mono leading-tight ${
                    isActive ? "text-white/70" : "text-gray-500"
                  }`}
                >
                  {t.sub}
                </div>
              )}
              {isLocked && gate?.missing?.length > 0 && !compact && (
                <div className="text-[10px] font-mono text-amber-300/80 mt-0.5">
                  Need: {gate.missing.join("; ")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!compact && onJumpToAdvanced && (
        <button
          onClick={onJumpToAdvanced}
          className="text-[10px] font-mono text-indigo-400 hover:text-indigo-200 self-end"
        >
          Show under-the-hood →
        </button>
      )}
    </div>
  );
}

// Pure helper used by both EasyMode and the gate UI in advanced mode.
// Returns { 3: {...}, 4: {...} } describing whether each gate is open
// and what's missing if not.
//
// gate(3): allocation across ≥3 markets, max single ≤ 50%, reinsurance bought.
// gate(4): per-thread — enforced at mint time. The "user-level" gate is
//   simply "do you currently have any free margin + any tier-3 access".
export function evaluateGates({ allocStats, hasReinsurance, hasFreeMargin }) {
  const t3Missing = [];
  if ((allocStats?.numMarkets ?? 0) < 3) {
    t3Missing.push(`allocate to ≥3 markets (have ${allocStats?.numMarkets ?? 0})`);
  }
  if ((allocStats?.maxWeight ?? 0) > 0.5 + 1e-6) {
    t3Missing.push(
      `no single market > 50% (max is ${((allocStats?.maxWeight ?? 0) * 100).toFixed(0)}%)`
    );
  }
  if (!hasReinsurance) {
    t3Missing.push("buy reinsurance coverage");
  }

  const t4Missing = [];
  if (!hasFreeMargin) {
    t4Missing.push("have free margin available");
  }

  return {
    3: { unlocked: t3Missing.length === 0, missing: t3Missing },
    4: { unlocked: t4Missing.length === 0, missing: t4Missing },
  };
}

// Compute the user's currently-exercised tier from their state.
// Returns 1..4. The highest tier the user is currently SITTING on,
// not the highest they could in principle reach.
export function currentTierOf({
  totalAllocated,    // dollars staked in insurance markets
  hasOpenLap,        // boolean — any active LAP position open
  floatsPrincipal,       // dollars committed to FLOAT threads
}) {
  if ((floatsPrincipal ?? 0) > 0) return 4;
  if (hasOpenLap) return 3;
  if ((totalAllocated ?? 0) > 0) return 2;
  return 1;
}
