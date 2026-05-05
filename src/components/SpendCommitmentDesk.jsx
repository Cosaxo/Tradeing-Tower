// SpendCommitmentDesk — Tier 5 UI.
//
// One desk that shows three things:
//   1. Your active and past commitments
//   2. Open auctions (any user's), where the local user can post a
//      bid as a synthetic seller (for demo purposes — in production
//      this would be merchant-side software)
//   3. A form to create a new commitment
//
// The existence of "self-bid as seller" mode in the UI is purely a
// demo convenience. In production, sellers run their own merchant
// integration; the protocol-level mechanism is the same.

import { useState, useMemo } from "react";
import {
  PERIOD_LENGTH_EPOCHS,
  DEFAULT_PENALTY_RATE,
  STATUS_OPEN_AUCTION,
  STATUS_ACTIVE_LOCK,
  STATUS_COMPLETED,
  STATUS_EXPIRED,
  STATUS_CANCELLED,
  projectFloatYield,
} from "../lib/spendCommitment.js";

const COMMON_CATEGORIES = [
  "groceries",
  "gas",
  "dining",
  "subscriptions",
  "household",
  "entertainment",
];

function statusColor(status) {
  switch (status) {
    case STATUS_OPEN_AUCTION:
      return "text-amber-300 bg-amber-950/40 border-amber-800";
    case STATUS_ACTIVE_LOCK:
      return "text-emerald-300 bg-emerald-950/40 border-emerald-800";
    case STATUS_COMPLETED:
      return "text-sky-300 bg-sky-950/40 border-sky-800";
    case STATUS_EXPIRED:
      return "text-rose-300 bg-rose-950/40 border-rose-800";
    case STATUS_CANCELLED:
      return "text-gray-400 bg-gray-900 border-gray-700";
    default:
      return "text-gray-400 bg-gray-900 border-gray-700";
  }
}

export function SpendCommitmentDesk({
  commitmentState,
  userId,
  currentEpoch,
  onCreate,
  onPostBid,
  onAcceptBid,
  onSpend,
  onCancel,
}) {
  const commitments = commitmentState?.commitments ?? [];
  const userCommitments = useMemo(
    () => commitments.filter((c) => c.userId === userId),
    [commitments, userId]
  );
  const openAuctionsByOthers = useMemo(
    () =>
      commitments.filter(
        (c) => c.userId !== userId && c.status === STATUS_OPEN_AUCTION
      ),
    [commitments, userId]
  );

  return (
    <div className="flex flex-col gap-3">
      <header className="rounded border border-violet-800 bg-violet-950/30 p-3">
        <h3 className="text-sm font-mono text-violet-200 font-bold mb-1">
          Tier 5 — Wallet-share commitments
        </h3>
        <p className="text-[10px] font-mono text-gray-400 leading-relaxed">
          Commit a budget for a category over a window. Sellers bid <em>cash</em> upfront
          to win your committed wallet-share — that's their customer-acquisition spend
          paid directly to you instead of to ad platforms. The locked FLOAT keeps
          earning ~8.5% APY while you shop normally over the period. Underspent
          amounts return at end-of-window minus a small penalty.
        </p>
      </header>

      <NewCommitmentForm onCreate={onCreate} />

      <YourCommitments
        commitments={userCommitments}
        userId={userId}
        currentEpoch={currentEpoch}
        onAcceptBid={onAcceptBid}
        onSpend={onSpend}
        onCancel={onCancel}
      />

      <OpenAuctionsAsSeller
        auctions={openAuctionsByOthers}
        userId={userId}
        onPostBid={onPostBid}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// New commitment form
// ---------------------------------------------------------------------------

function NewCommitmentForm({ onCreate }) {
  const [category, setCategory] = useState("groceries");
  const [budgetPerPeriod, setBudgetPerPeriod] = useState("200");
  const [numPeriods, setNumPeriods] = useState("6");

  const budgetNum = parseFloat(budgetPerPeriod);
  const periodsNum = parseInt(numPeriods, 10);
  const total =
    Number.isFinite(budgetNum) && Number.isFinite(periodsNum)
      ? budgetNum * periodsNum
      : 0;
  const validInputs = total > 0 && Number.isInteger(periodsNum) && periodsNum > 0;

  function handleSubmit(e) {
    e.preventDefault();
    if (!validInputs) return;
    onCreate?.({
      category,
      budgetPerPeriod: budgetNum,
      numPeriods: periodsNum,
    });
    // Reset to typical defaults so the next auction is one click away.
  }

  // Float-yield projection at 8.5% annualised.
  const projection = projectFloatYield({
    commitment: { totalCommitment: total, numPeriods: periodsNum || 0 },
    annualYieldRate: 0.085,
  });

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded border border-gray-800 bg-gray-950/40 p-3 flex flex-col gap-2"
    >
      <span className="text-xs font-mono text-gray-200 font-bold">
        Auction a budget
      </span>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-500">Category</span>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded text-xs font-mono text-gray-200 px-2 py-1"
          >
            {COMMON_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-500">
            Budget / period ($)
          </span>
          <input
            type="number"
            min="1"
            step="10"
            value={budgetPerPeriod}
            onChange={(e) => setBudgetPerPeriod(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded text-xs font-mono text-gray-200 px-2 py-1"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-500">Periods</span>
          <input
            type="number"
            min="1"
            step="1"
            value={numPeriods}
            onChange={(e) => setNumPeriods(e.target.value)}
            className="bg-gray-900 border border-gray-700 rounded text-xs font-mono text-gray-200 px-2 py-1"
          />
        </label>
      </div>
      <div className="flex items-center justify-between mt-1">
        <span className="text-[10px] font-mono text-gray-400">
          Total commitment:{" "}
          <span className="text-violet-300">${total.toFixed(0)}</span>
          {" · "}
          Float yield estimate:{" "}
          <span className="text-emerald-300">${projection.toFixed(2)}</span>
        </span>
        <button
          type="submit"
          disabled={!validInputs}
          className={`text-xs font-mono px-3 py-1 rounded ${
            validInputs
              ? "bg-violet-700 hover:bg-violet-600 text-white"
              : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
        >
          Auction commitment
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Your commitments — list with bid acceptance + spend + cancel actions
// ---------------------------------------------------------------------------

function YourCommitments({
  commitments,
  userId,
  currentEpoch,
  onAcceptBid,
  onSpend,
  onCancel,
}) {
  if (commitments.length === 0) {
    return (
      <div className="rounded border border-gray-800 bg-gray-950/40 p-3 text-[10px] font-mono text-gray-500">
        You have no commitments. Create one above to start.
      </div>
    );
  }
  return (
    <div className="rounded border border-gray-800 bg-gray-950/40 p-3 flex flex-col gap-2">
      <span className="text-xs font-mono text-gray-200 font-bold">
        Your commitments
      </span>
      {commitments.map((c) => (
        <CommitmentRow
          key={c.id}
          commitment={c}
          currentEpoch={currentEpoch}
          onAcceptBid={onAcceptBid}
          onSpend={onSpend}
          onCancel={onCancel}
          userId={userId}
        />
      ))}
    </div>
  );
}

function CommitmentRow({ commitment: c, currentEpoch, onAcceptBid, onSpend, onCancel }) {
  const cls = statusColor(c.status);
  const remaining = c.lockedAmount - c.spentAmount;
  const progressPct =
    c.lockedAmount > 0
      ? Math.max(0, Math.min(100, (c.spentAmount / c.lockedAmount) * 100))
      : 0;
  const ticksRemaining =
    c.expiresAtEpoch != null ? Math.max(0, c.expiresAtEpoch - currentEpoch) : null;

  const [spendInput, setSpendInput] = useState("");
  const spendNum = parseFloat(spendInput);
  const canSpend =
    c.status === STATUS_ACTIVE_LOCK &&
    Number.isFinite(spendNum) &&
    spendNum > 0 &&
    spendNum <= remaining + 1e-9;

  return (
    <div className={`rounded border p-2 flex flex-col gap-1 ${cls}`}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-mono">
          <strong>{c.category}</strong> · ${c.budgetPerPeriod}/period × {c.numPeriods}{" "}
          = ${c.totalCommitment}
        </span>
        <span className="text-[10px] font-mono">{c.status.replace("_", " ")}</span>
      </div>

      {c.status === STATUS_OPEN_AUCTION && (
        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-mono text-gray-300">
            Bids: {c.bids.length}
            {c.bids.length > 0 && (
              <>
                {" — best: "}
                <span className="text-emerald-300 font-bold">
                  ${Math.max(...c.bids.map((b) => b.bidAmount)).toFixed(0)}
                </span>
                {" by "}
                {c.bids.find(
                  (b) => b.bidAmount === Math.max(...c.bids.map((x) => x.bidAmount))
                )?.sellerId}
              </>
            )}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => onAcceptBid?.({ commitmentId: c.id })}
              disabled={c.bids.length === 0}
              className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                c.bids.length > 0
                  ? "bg-emerald-700 hover:bg-emerald-600 text-white"
                  : "bg-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              Accept best bid
            </button>
            <button
              onClick={() => onCancel?.({ commitmentId: c.id })}
              className="text-[10px] font-mono px-2 py-0.5 rounded bg-gray-800 text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {c.status === STATUS_ACTIVE_LOCK && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-[10px] font-mono text-gray-300">
            <span>
              At <strong>{c.acceptedSeller}</strong> · received{" "}
              <span className="text-emerald-300">${c.acceptedBidAmount.toFixed(0)}</span>{" "}
              upfront
            </span>
            <span>
              {ticksRemaining != null && `${ticksRemaining} ticks left`}
            </span>
          </div>
          <div className="h-1.5 bg-gray-800 rounded overflow-hidden">
            <div
              className="h-full bg-emerald-500"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <div className="flex items-center justify-between text-[10px] font-mono">
            <span>
              spent ${c.spentAmount.toFixed(0)} / ${c.lockedAmount.toFixed(0)}
              {" — "}remaining ${remaining.toFixed(0)}
            </span>
          </div>
          <div className="flex gap-1 mt-1">
            <input
              type="number"
              min="0"
              step="10"
              placeholder="$ to spend"
              value={spendInput}
              onChange={(e) => setSpendInput(e.target.value)}
              className="flex-1 bg-gray-900 border border-gray-700 rounded text-[10px] font-mono text-gray-200 px-2 py-0.5"
            />
            <button
              onClick={() => {
                if (!canSpend) return;
                onSpend?.({ commitmentId: c.id, amount: spendNum });
                setSpendInput("");
              }}
              disabled={!canSpend}
              className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                canSpend
                  ? "bg-violet-700 hover:bg-violet-600 text-white"
                  : "bg-gray-800 text-gray-600 cursor-not-allowed"
              }`}
            >
              Spend at {c.acceptedSeller}
            </button>
          </div>
        </div>
      )}

      {c.status === STATUS_COMPLETED && (
        <span className="text-[10px] font-mono text-sky-300">
          Fully spent. Bid-payment + float-yield retained, no penalty.
        </span>
      )}

      {c.status === STATUS_EXPIRED && (
        <span className="text-[10px] font-mono text-rose-300">
          Expired with ${(c.lockedAmount - c.spentAmount).toFixed(2)} unspent ·
          penalty {((1 - 0) * DEFAULT_PENALTY_RATE * 100).toFixed(0)}% of unspent
          paid to {c.acceptedSeller}
        </span>
      )}

      {c.status === STATUS_CANCELLED && (
        <span className="text-[10px] font-mono text-gray-400">
          Cancelled before any bid was accepted.
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Open auctions you can bid on (as a seller)
// ---------------------------------------------------------------------------

function OpenAuctionsAsSeller({ auctions, userId, onPostBid }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-950/40 p-3 flex flex-col gap-2">
      <span className="text-xs font-mono text-gray-200 font-bold">
        Open auctions (bid as seller)
      </span>
      <p className="text-[10px] font-mono text-gray-500">
        In production, sellers' merchant systems post bids automatically. Here
        you can post bids manually as a demo seller to see the full flow.
      </p>
      {auctions.length === 0 ? (
        <span className="text-[10px] font-mono text-gray-500">
          No open auctions from other users right now. Open another tab to
          create one as a different user, or create one yourself above.
        </span>
      ) : (
        auctions.map((c) => (
          <BidRow key={c.id} commitment={c} userId={userId} onPostBid={onPostBid} />
        ))
      )}
    </div>
  );
}

function BidRow({ commitment: c, userId, onPostBid }) {
  const [bidInput, setBidInput] = useState("");
  const [sellerInput, setSellerInput] = useState("merchant-1");
  const bidNum = parseFloat(bidInput);
  const canBid = Number.isFinite(bidNum) && bidNum > 0;
  const bestBid = c.bids.length
    ? Math.max(...c.bids.map((b) => b.bidAmount))
    : 0;
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-2 flex flex-col gap-1">
      <div className="flex items-center justify-between text-[10px] font-mono text-gray-300">
        <span>
          {c.userId} wants <strong>{c.category}</strong> at $
          {c.budgetPerPeriod}/period × {c.numPeriods}{" "}
          <span className="text-gray-500">= ${c.totalCommitment}</span>
        </span>
        <span>
          {c.bids.length > 0 ? (
            <>best so far: <span className="text-emerald-300">${bestBid.toFixed(0)}</span></>
          ) : (
            <span className="text-gray-500">no bids yet</span>
          )}
        </span>
      </div>
      <div className="flex gap-1">
        <input
          type="text"
          placeholder="seller id"
          value={sellerInput}
          onChange={(e) => setSellerInput(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded text-[10px] font-mono text-gray-200 px-2 py-0.5 w-32"
        />
        <input
          type="number"
          min="1"
          step="5"
          placeholder="$ bid"
          value={bidInput}
          onChange={(e) => setBidInput(e.target.value)}
          className="flex-1 bg-gray-900 border border-gray-700 rounded text-[10px] font-mono text-gray-200 px-2 py-0.5"
        />
        <button
          onClick={() => {
            if (!canBid || !sellerInput.trim()) return;
            onPostBid?.({
              commitmentId: c.id,
              sellerId: sellerInput.trim(),
              bidAmount: bidNum,
            });
            setBidInput("");
          }}
          disabled={!canBid || !sellerInput.trim()}
          className={`text-[10px] font-mono px-2 py-0.5 rounded ${
            canBid && sellerInput.trim()
              ? "bg-amber-700 hover:bg-amber-600 text-white"
              : "bg-gray-800 text-gray-600 cursor-not-allowed"
          }`}
        >
          Post bid
        </button>
      </div>
    </div>
  );
}
