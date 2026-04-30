// Insurance Markets desk — the heart of the Phase-5 collateral system.
//
// The user allocates percentages of their working capital across the
// protocol's insurance markets. Every dollar allocated:
//
//   - Sits as the INSURER side of a market (collects premiums, pays
//     out if the event triggers)
//   - Backs LAP credit (LTV climbs with allocation diversification)
//   - Backs Tower Tether mint capacity
//
// The desk has three sections:
//
//   1. Header summary: free margin to allocate, total allocated, LTV.
//   2. Per-market sliders grouped by category (per-pair / macro). Each
//      row shows the live premium rate, the user's current stake, and
//      what they're earning.
//   3. Reinsurance summary (read-only): the user's face on each of
//      the 3 reinsurance products (auto-bought when minting TT).

import { useState, useMemo, useEffect } from "react";
import { HelpHint } from "./Tooltip.jsx";
import { STANDARD_EVENTS } from "../lib/insuranceEvents.js";
import { PAIRS } from "../constants/assets.js";

const COLOR_PAIR_PRICE = "#60a5fa";
const COLOR_MACRO = "#a78bfa";

export function InsuranceDesk({
  insuranceState,
  playerId = "You",
  freeMarginToAllocate = 0,
  poolLtv = null,
  onSetAllocation,
}) {
  const markets = useMemo(
    () => insuranceState?.markets ?? [],
    [insuranceState]
  );
  const reinsurance = insuranceState?.reinsurance ?? [];
  const userAlloc =
    insuranceState?.allocations?.byUser?.[playerId]?.allocations ?? {};

  // Local editing state — sliders adjust this; user clicks Apply to commit.
  const [draft, setDraft] = useState({});
  // Initialise/refresh draft whenever the materialised allocation changes.
  useEffect(() => {
    setDraft({ ...userAlloc });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(userAlloc)]);

  const draftSum = useMemo(
    () => Object.values(draft).reduce((s, v) => s + (v || 0), 0),
    [draft]
  );
  const draftSumPct = Math.round(draftSum * 100);
  const overAllocated = draftSum > 1.0001;

  // Look up the registry entry for each market so we can show the label.
  const eventByMarketId = useMemo(() => {
    const out = {};
    for (const m of markets) {
      const ev = STANDARD_EVENTS.find((e) => e.id === m.eventId);
      if (ev) out[m.id] = ev;
    }
    return out;
  }, [markets]);

  const grouped = useMemo(() => {
    const out = { "pair-price": [], macro: [] };
    for (const m of markets) {
      const ev = eventByMarketId[m.id];
      if (!ev) continue;
      out[ev.category]?.push({ market: m, event: ev });
    }
    return out;
  }, [markets, eventByMarketId]);

  function setSlider(marketId, pct) {
    setDraft((prev) => ({ ...prev, [marketId]: pct }));
  }
  function clearSlider(marketId) {
    setDraft((prev) => {
      const { [marketId]: _omit, ...rest } = prev;
      return rest;
    });
  }
  function spreadEqually() {
    const n = markets.length;
    if (n === 0) return;
    const equal = 1 / n;
    setDraft(Object.fromEntries(markets.map((m) => [m.id, equal])));
  }
  function clearAll() {
    setDraft({});
  }
  function apply() {
    if (overAllocated) return;
    onSetAllocation?.(draft);
  }

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(userAlloc);

  // Total user stake — for header summary.
  const totalStake = markets.reduce(
    (s, m) => s + (m.insurerPositions?.[playerId] ?? 0),
    0
  );

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      {/* Header */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Insurance Markets
          <HelpHint
            width={340}
            text="Each market pays out when its event happens. As an insurer (default position), you collect a per-period premium and pay out if the event triggers. Spread your allocation across many distinct events to lift your LTV (more pool credit) and prepare for Tower Tether minting. The 3 reinsurance products auto-buy when you mint TT — they cover your insurer-side losses up to 1.5× the mint amount."
          />
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-indigo-700 bg-indigo-950 text-indigo-300">
          LTV {(poolLtv?.ltv ?? 0).toFixed(2)}
        </span>
      </div>

      {/* Stat strip */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <Stat label="Free margin" value={`$${freeMarginToAllocate.toFixed(0)}`} color="text-emerald-300" />
        <Stat label="Allocated" value={`$${totalStake.toFixed(0)}`} color="text-amber-300" />
        <Stat label="Markets used" value={`${(poolLtv?.stats?.numMarkets ?? 0)}/${markets.length}`} color="text-indigo-300" />
        <Stat
          label="Draft total"
          value={`${draftSumPct}%`}
          color={overAllocated ? "text-red-400" : draftSumPct === 100 ? "text-emerald-300" : "text-gray-200"}
        />
      </div>

      {/* Quick actions */}
      <div className="flex gap-1">
        <button
          onClick={spreadEqually}
          className="text-[10px] font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:border-gray-500 transition-colors"
        >
          Equal split
        </button>
        <button
          onClick={clearAll}
          className="text-[10px] font-mono px-2 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:bg-gray-700 hover:border-gray-500 transition-colors"
        >
          Clear
        </button>
        <button
          onClick={apply}
          disabled={!dirty || overAllocated}
          className={`ml-auto text-[10px] font-mono px-3 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            dirty && !overAllocated
              ? "border-emerald-700 bg-emerald-950 text-emerald-200 hover:bg-emerald-900"
              : "border-gray-700 bg-gray-800 text-gray-400"
          }`}
          title={overAllocated ? "Total exceeds 100%" : dirty ? "Apply your draft" : "No changes to apply"}
        >
          Apply allocation
        </button>
      </div>

      {/* Per-pair price events */}
      {grouped["pair-price"].length > 0 && (
        <Section title="Per-pair price events" color={COLOR_PAIR_PRICE}>
          {grouped["pair-price"].map(({ market, event }) => (
            <MarketRow
              key={market.id}
              market={market}
              event={event}
              draftPct={draft[market.id] ?? 0}
              userStake={market.insurerPositions?.[playerId] ?? 0}
              freeMargin={freeMarginToAllocate}
              onChange={(v) => setSlider(market.id, v)}
              onClear={() => clearSlider(market.id)}
              accent={COLOR_PAIR_PRICE}
            />
          ))}
        </Section>
      )}

      {/* Macro events */}
      {grouped["macro"].length > 0 && (
        <Section title="Macro events" color={COLOR_MACRO}>
          {grouped["macro"].map(({ market, event }) => (
            <MarketRow
              key={market.id}
              market={market}
              event={event}
              draftPct={draft[market.id] ?? 0}
              userStake={market.insurerPositions?.[playerId] ?? 0}
              freeMargin={freeMarginToAllocate}
              onChange={(v) => setSlider(market.id, v)}
              onClear={() => clearSlider(market.id)}
              accent={COLOR_MACRO}
            />
          ))}
        </Section>
      )}

      {/* Reinsurance summary */}
      <ReinsuranceSummary reinsurance={reinsurance} playerId={playerId} />

      {overAllocated && (
        <div className="text-[10px] font-mono text-red-400 border border-red-800 bg-red-950/40 px-2 py-1 rounded">
          Over-allocated: total {draftSumPct}% &gt; 100%. Reduce some
          sliders before applying.
        </div>
      )}

      {totalStake === 0 && (
        <div className="text-[10px] font-mono text-gray-500 border border-gray-800 px-2 py-1 rounded">
          You haven't allocated yet. Use <strong className="text-gray-300">Equal split</strong> to
          fan out across all markets, or set sliders manually. Then click{" "}
          <strong className="text-emerald-300">Apply allocation</strong>.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, color }) {
  return (
    <div>
      <div className="text-[10px] text-gray-500 font-mono">{label}</div>
      <div className={`text-sm font-mono ${color}`}>{value}</div>
    </div>
  );
}

function Section({ title, color, children }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
      <div className="text-[10px] font-mono uppercase" style={{ color }}>
        {title}
      </div>
      <div className="flex flex-col gap-1">{children}</div>
    </div>
  );
}

function MarketRow({
  market,
  event,
  draftPct,
  userStake,
  freeMargin,
  onChange,
  onClear,
  accent,
}) {
  const pctInt = Math.round((draftPct || 0) * 100);
  const draftDollars = Math.max(0, draftPct * freeMargin);
  const premiumPct = market.premiumRate * 100;
  const earningPerEpoch = userStake * market.premiumRate;
  const pair = event?.pairKey ? PAIRS[event.pairKey] : null;

  return (
    <div className="flex items-center gap-2 px-1 py-1 rounded hover:bg-gray-900/40">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1">
          <span className="text-[11px] font-mono text-gray-200 truncate" title={event.label}>
            {event.label}
          </span>
          {pair && (
            <span
              className="text-[9px] font-mono px-1 rounded border border-gray-700 text-gray-500"
              title={pair.symbol}
            >
              {pair.symbol}
            </span>
          )}
        </div>
        <div className="text-[10px] font-mono text-gray-500">
          premium {premiumPct.toFixed(2)}%/period
          {userStake > 0 && (
            <span className="text-emerald-400 ml-2">
              · earning ${earningPerEpoch.toFixed(2)}/period (stake ${userStake.toFixed(0)})
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1 w-44">
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={pctInt}
          onChange={(e) => onChange(parseInt(e.target.value, 10) / 100)}
          className="flex-1"
          style={{ accentColor: accent }}
        />
        <span className="text-[10px] font-mono text-gray-300 w-8 text-right">
          {pctInt}%
        </span>
      </div>
      <div className="text-[10px] font-mono text-gray-400 w-16 text-right" title="Dollars at this allocation">
        ${draftDollars.toFixed(0)}
      </div>
      {pctInt > 0 && (
        <button
          onClick={onClear}
          className="text-[10px] font-mono text-gray-500 hover:text-red-400 px-1"
          aria-label="Clear allocation"
          title="Clear allocation for this market"
        >
          ×
        </button>
      )}
    </div>
  );
}

function ReinsuranceSummary({ reinsurance, playerId }) {
  const myFaces = reinsurance.map((p) => ({
    label: p.label,
    coverageFraction: p.coverageFraction,
    face: p.buyerCoverage?.[playerId] ?? 0,
    sellerCapital: p.sellerCapital ?? 0,
    premiumRate: p.premiumRate ?? 0,
  }));
  const totalFace = myFaces.reduce((s, x) => s + x.face, 0);
  const fullyHeld = myFaces.every((x) => x.face > 0);

  return (
    <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono uppercase text-amber-300">
          Reinsurance
          <HelpHint
            width={300}
            text="Three parallel products that pay out when YOU (as an insurer in any market) face a claim. Auto-bought when you mint Tower Tether — face is sized to 1.5× the mint amount, split across the 3 products. You can hold them outside of TT minting too; they protect any insurer-side exposure."
          />
        </span>
        <span className="text-[10px] font-mono text-gray-400">
          total face ${totalFace.toFixed(0)}{" "}
          {fullyHeld ? (
            <span className="text-emerald-400">· covered</span>
          ) : (
            <span className="text-gray-600">· partial</span>
          )}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-1">
        {myFaces.map(({ label, coverageFraction, face, premiumRate }) => (
          <div
            key={label}
            className="flex flex-col rounded border border-gray-800 bg-gray-900 px-2 py-1"
          >
            <div className="text-[10px] font-mono text-gray-300">{label}</div>
            <div className="text-[9px] font-mono text-gray-500">
              {(coverageFraction * 100).toFixed(0)}% of any loss
            </div>
            <div className="text-[10px] font-mono text-amber-300 mt-1">
              face ${face.toFixed(0)}
            </div>
            <div className="text-[9px] font-mono text-gray-500">
              premium {(premiumRate * 100).toFixed(2)}%/period
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
