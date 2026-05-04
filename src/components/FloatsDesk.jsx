// Float (FLOAT) Desk — open threads, balance, redemption queue,
// send-to-merchant.
//
// Thread model: minting opens a "thread" of value where the same dollar
// simultaneously serves four roles — T-bill stake, insurance-seller
// fill across reinsurance-covered markets, a delta-neutral paired LAP
// (auto-leased), and the minted FLOAT itself. No LTV gate, no coefficient.
// The gate is "do you have $X of free margin to commit?" because the
// dollar is locked across all four jobs at once and a loss in any one
// of them shrinks the others atomically.
//
// Three actions:
//
//   - Mint:    open a thread for $X. Free margin gets the threadStake
//              tag; insurance fills, paired LAP, and FLOAT all materialise.
//   - Send:    transfer FLOAT to the simulated merchant — represents an
//              outside-protocol purchase. Merchant auto-redeems on
//              cycle to create organic queue pressure.
//   - Redeem:  hand FLOAT back for $. Standard tier respects the 10%
//              per-cycle cap; Express tier pays a 5% penalty (routed
//              to reinsurance sellers) to bypass the cap. Each cleared
//              redemption shrinks one or more threads — atomically
//              writing down all four of their layers.
import { useState } from "react";
import { HelpHint } from "./Tooltip.jsx";
import {
  STANDARD_REDEMPTION_CAP_PCT,
  EXPRESS_PENALTY_RATE,
  REDEMPTION_EVERY,
} from "../constants/system.js";

export function FloatsDesk({
  floatsState,
  playerId = "You",
  freeMargin = 0,
  threadPrincipal = 0,
  onMint,
  onSendToMerchant,
  onRedeem,
  onCancelRedemption,
}) {
  const [mintAmount, setMintAmount] = useState(100);
  const [sendAmount, setSendAmount] = useState(50);
  const [redeemAmount, setRedeemAmount] = useState(50);
  const [express, setExpress] = useState(false);

  const balance = floatsState?.balances?.[playerId] ?? 0;
  const debt = floatsState?.debtByUser?.[playerId] ?? 0;
  const threads = (floatsState?.threads ?? []).filter(
    (t) => !t.closed && t.ownerId === playerId
  );
  const minted = threads.reduce((s, t) => s + t.floatFace, 0);
  const totalSupply = (floatsState?.threads ?? [])
    .filter((t) => !t.closed)
    .reduce((s, t) => s + t.floatFace, 0);
  const merchantBalance = floatsState?.merchantBalance ?? 0;
  const queue = floatsState?.redemptionQueue ?? [];
  const cycleCap = totalSupply * STANDARD_REDEMPTION_CAP_PCT;

  const myQueueEntries = queue.filter((q) => q.userId === playerId);
  const merchantQueueEntries = queue.filter((q) => q.userId === "MERCHANT");

  const mintMax = Math.max(0, Math.floor(freeMargin));

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Float (FLOAT) — Threads
          <HelpHint
            width={360}
            text="Mint FLOAT 1:1 against free margin. The dollar you commit serves FOUR roles at once: a T-bill stake, an insurance-seller fill across reinsurance-covered markets, a neutral paired LAP (both legs auto-leased), and the FLOAT itself. Loss in any layer shrinks all four. Redemption sells T-bills for cash and atomically unwinds the other layers. 10% standard cap per cycle; Express bypasses the cap for a 5% penalty (paid to reinsurance sellers)."
          />
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-700 bg-emerald-950 text-emerald-200">
          ${balance.toFixed(2)} FLOAT
        </span>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Wallet</div>
          <div className="text-sm font-mono text-emerald-300">
            {balance.toFixed(0)}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Minted</div>
          <div className="text-sm font-mono text-amber-300">{minted.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Threads</div>
          <div className="text-sm font-mono text-indigo-300">{threads.length}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Free margin</div>
          <div className="text-sm font-mono text-gray-200">
            ${freeMargin.toFixed(0)}
          </div>
        </div>
      </div>

      {threadPrincipal > 0 && (
        <div className="text-[10px] font-mono text-gray-400 border border-gray-800 bg-gray-950 px-2 py-1 rounded">
          Thread principal locked: <span className="text-amber-300">${threadPrincipal.toFixed(0)}</span>
          {" — "}same $ deployed across T-bill, insurance, LAP, and FLOAT.
        </div>
      )}

      {debt > 0 && (
        <div className="text-[10px] font-mono text-red-400 border border-red-800 bg-red-950/40 px-2 py-1 rounded">
          DEBT: ${debt.toFixed(2)} owed (clawback shortfall — affects new mints
          until repaid).
        </div>
      )}

      {/* Mint */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Open thread (mint FLOAT)
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={10}
            max={Math.max(10, mintMax)}
            step={10}
            value={Math.min(mintAmount, Math.max(10, mintMax))}
            onChange={(e) => setMintAmount(parseInt(e.target.value))}
            className="flex-1 accent-emerald-500"
            disabled={mintMax < 10}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${mintAmount}
          </span>
          <button
            onClick={() => onMint?.(mintAmount)}
            disabled={mintMax < 10 || mintAmount > mintMax}
            className="text-[10px] font-mono px-3 py-1 rounded border border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Open thread
          </button>
        </div>
        <div className="text-[9px] font-mono text-gray-600">
          Deploys ${mintAmount} as: T-bill + insurance fill + neutral paired LAP + ${mintAmount} FLOAT.
        </div>
      </div>

      {/* Send to merchant */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase flex items-center">
          Send to Merchant (simulated purchase)
          <HelpHint
            width={260}
            text="Simulates spending FLOAT outside the protocol. The merchant pool periodically auto-redeems chunks of its balance, creating organic redemption-queue pressure. In production this is just a wallet-to-wallet transfer; here we model the redemption side."
          />
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={Math.max(1, Math.floor(balance))}
            step={1}
            value={Math.min(sendAmount, Math.max(1, Math.floor(balance)))}
            onChange={(e) => setSendAmount(parseInt(e.target.value))}
            className="flex-1 accent-purple-500"
            disabled={balance < 1}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${sendAmount}
          </span>
          <button
            onClick={() => onSendToMerchant?.(sendAmount)}
            disabled={balance < sendAmount || balance < 1}
            className="text-[10px] font-mono px-3 py-1 rounded border border-purple-700 bg-purple-950 text-purple-200 hover:bg-purple-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
        <div className="text-[10px] font-mono text-gray-600">
          Merchant pool: ${merchantBalance.toFixed(0)} FLOAT
        </div>
      </div>

      {/* Redeem */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Redeem FLOAT for $
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={1}
            max={Math.max(1, Math.floor(balance))}
            step={1}
            value={Math.min(redeemAmount, Math.max(1, Math.floor(balance)))}
            onChange={(e) => setRedeemAmount(parseInt(e.target.value))}
            className="flex-1 accent-red-500"
            disabled={balance < 1}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${redeemAmount}
          </span>
        </div>
        <label className="flex items-center gap-2 text-[10px] font-mono text-gray-400 cursor-pointer">
          <input
            type="checkbox"
            checked={express}
            onChange={(e) => setExpress(e.target.checked)}
            className="accent-amber-500"
          />
          <span>
            Express tier ({(EXPRESS_PENALTY_RATE * 100).toFixed(0)}% penalty,
            skips queue/cap)
          </span>
        </label>
        <button
          onClick={() => onRedeem?.(redeemAmount, express)}
          disabled={balance < redeemAmount || balance < 1}
          className={`text-[10px] font-mono px-3 py-1 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            express
              ? "border-amber-700 bg-amber-950 text-amber-200 hover:bg-amber-900"
              : "border-gray-700 bg-gray-800 text-gray-200 hover:bg-gray-700"
          }`}
        >
          {express
            ? `Queue Express (you'll receive $${(redeemAmount * (1 - EXPRESS_PENALTY_RATE)).toFixed(2)})`
            : `Queue Standard ($${redeemAmount.toFixed(2)})`}
        </button>
      </div>

      {/* Queue display */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-gray-500 font-mono uppercase">
            Redemption Queue
          </span>
          <span className="text-[10px] font-mono text-gray-500">
            cycle every {REDEMPTION_EVERY} medium ticks · cap ${cycleCap.toFixed(0)}
          </span>
        </div>
        {queue.length === 0 && (
          <span className="text-[10px] font-mono text-gray-600">empty</span>
        )}
        {myQueueEntries.length > 0 &&
          myQueueEntries.map((q) => (
            <div
              key={q.id}
              className="flex items-center justify-between text-[10px] font-mono"
            >
              <span className="text-gray-300">
                {q.express ? "EXPRESS" : "STANDARD"} · ${q.amount.toFixed(2)}
                {q.express && (
                  <span className="text-amber-400 ml-1">
                    (−${(q.amount * q.penaltyRate).toFixed(2)} penalty)
                  </span>
                )}
              </span>
              <button
                onClick={() => onCancelRedemption?.(q.id)}
                className="text-red-400 hover:text-red-200 px-1"
                aria-label="Cancel redemption"
              >
                cancel
              </button>
            </div>
          ))}
        {merchantQueueEntries.length > 0 && (
          <div className="text-[10px] font-mono text-gray-500">
            Merchant: {merchantQueueEntries.length} pending · $
            {merchantQueueEntries
              .reduce((s, q) => s + q.amount, 0)
              .toFixed(0)}
          </div>
        )}
      </div>

      <div className="text-[10px] font-mono text-gray-500">
        Total supply: ${totalSupply.toFixed(0)} FLOAT · Cumulative penalty to
        sellers: ${(floatsState?.cumulativePenaltyToPool ?? 0).toFixed(2)}
      </div>
    </div>
  );
}
