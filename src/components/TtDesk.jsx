// Tower Tether (TT) Desk — mint, balance, redemption queue, send-to-merchant.
//
// Phase 4 surface for the protocol's stablecoin. Critically, TT has NO
// in-protocol utility (no fee acceptance, no power-up sinks). Its
// purpose is to circulate OUTSIDE the protocol (the eventual moat is
// merchant acceptance like a credit-card network). This desk gives the
// user three actions:
//
//   - Mint:    against pool-deposit collateral, capped by LTV × deposit ×
//              MINT_COEFFICIENT. Requires LTV ≥ MINT_LTV_GATE.
//   - Send:    to a simulated merchant — represents real-world purchase.
//              The merchant accumulates TT and periodically auto-redeems,
//              creating organic redemption-queue pressure.
//   - Redeem:  hand TT back for dollars. Standard tier waits its turn at
//              no cost (10% of supply per ~monthly cycle); Express tier
//              clears immediately, paying a 5% penalty to the insurance
//              pool. Any minter whose collateral backed redeemed TT loses
//              pro-rata.
import { useState } from "react";
import { HelpHint } from "./Tooltip.jsx";
import {
  MINT_COEFFICIENT,
  MINT_LTV_GATE,
  STANDARD_REDEMPTION_CAP_PCT,
  EXPRESS_PENALTY_RATE,
  REDEMPTION_EVERY,
} from "../constants/system.js";

export function TtDesk({
  ttState,
  playerId = "You",
  ltv = 0,
  poolDeposit = 0,
  mintCapacityRemaining = 0,
  onMint,
  onSendToMerchant,
  onRedeem,
  onCancelRedemption,
}) {
  const [mintAmount, setMintAmount] = useState(100);
  const [sendAmount, setSendAmount] = useState(50);
  const [redeemAmount, setRedeemAmount] = useState(50);
  const [express, setExpress] = useState(false);

  const balance = ttState?.balances?.[playerId] ?? 0;
  const minted = ttState?.mintedByUser?.[playerId] ?? 0;
  const debt = ttState?.debtByUser?.[playerId] ?? 0;
  const totalSupply = Object.values(ttState?.mintedByUser ?? {}).reduce(
    (s, v) => s + v,
    0
  );
  const merchantBalance = ttState?.merchantBalance ?? 0;
  const queue = ttState?.redemptionQueue ?? [];
  const cycleCap = totalSupply * STANDARD_REDEMPTION_CAP_PCT;

  const myQueueEntries = queue.filter((q) => q.userId === playerId);
  const merchantQueueEntries = queue.filter((q) => q.userId === "MERCHANT");

  const aboveGate = ltv >= MINT_LTV_GATE;
  const cap = poolDeposit * ltv * MINT_COEFFICIENT;

  return (
    <div className="flex flex-col gap-3 p-3 rounded border border-gray-700 bg-gray-900">
      <div className="flex items-center justify-between">
        <span className="text-xs font-mono text-gray-300 flex items-center">
          Tower Tether (TT)
          <HelpHint
            width={320}
            text="Fully-collateralized stablecoin minted against your pool deposit. Designed for OUTSIDE the protocol — the goal is merchant acceptance like a credit-card network. No in-protocol utility on purpose. Mint cap = deposit × LTV × 0.5, gated by LTV ≥ 0.6. Redemption is rate-limited: 10% of supply per ~monthly cycle (standard tier, free) or pay a 5% penalty for Express to skip the cap. When TT is redeemed, the minters whose collateral backed it lose pro-rata."
          />
        </span>
        <span className="text-[10px] font-mono px-2 py-0.5 rounded border border-emerald-700 bg-emerald-950 text-emerald-200">
          ${balance.toFixed(2)} TT
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
          <div className="text-[10px] text-gray-500 font-mono">Cap</div>
          <div className="text-sm font-mono text-indigo-300">{cap.toFixed(0)}</div>
        </div>
        <div>
          <div className="text-[10px] text-gray-500 font-mono">Available</div>
          <div className="text-sm font-mono text-gray-200">
            {Math.max(0, mintCapacityRemaining).toFixed(0)}
          </div>
        </div>
      </div>

      {debt > 0 && (
        <div className="text-[10px] font-mono text-red-400 border border-red-800 bg-red-950/40 px-2 py-1 rounded">
          DEBT: ${debt.toFixed(2)} owed (clawback shortfall — blocks new mints
          until repaid via shrinking outstanding mint).
        </div>
      )}

      {!aboveGate && (
        <div className="text-[10px] font-mono text-amber-400 border border-amber-800 bg-amber-950/30 px-2 py-1 rounded">
          LTV {ltv.toFixed(2)} below mint gate {MINT_LTV_GATE.toFixed(2)} —
          diversify your book to unlock minting.
        </div>
      )}

      {/* Mint */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Mint TT
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={10}
            max={Math.max(10, Math.floor(mintCapacityRemaining))}
            step={10}
            value={Math.min(mintAmount, Math.max(10, Math.floor(mintCapacityRemaining)))}
            onChange={(e) => setMintAmount(parseInt(e.target.value))}
            className="flex-1 accent-emerald-500"
            disabled={!aboveGate || mintCapacityRemaining < 10}
          />
          <span className="text-[10px] font-mono text-gray-300 w-12 text-right">
            ${mintAmount}
          </span>
          <button
            onClick={() => onMint?.(mintAmount)}
            disabled={!aboveGate || mintAmount > mintCapacityRemaining || mintCapacityRemaining < 10}
            className="text-[10px] font-mono px-3 py-1 rounded border border-emerald-700 bg-emerald-950 text-emerald-300 hover:bg-emerald-900 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Mint
          </button>
        </div>
      </div>

      {/* Send to merchant */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase flex items-center">
          Send to Merchant (simulated purchase)
          <HelpHint
            width={260}
            text="Simulates spending TT in the real world. The merchant pool periodically auto-redeems chunks of its balance, creating organic redemption-queue pressure. In production this is just a wallet-to-wallet transfer; here we model the redemption side."
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
          Merchant pool: ${merchantBalance.toFixed(0)} TT
        </div>
      </div>

      {/* Redeem */}
      <div className="flex flex-col gap-1 rounded border border-gray-800 bg-gray-950 px-2 py-2">
        <span className="text-[10px] text-gray-500 font-mono uppercase">
          Redeem TT for $
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
        Total supply: ${totalSupply.toFixed(0)} TT · Cumulative penalty to
        pool: ${(ttState?.cumulativePenaltyToPool ?? 0).toFixed(2)}
      </div>
    </div>
  );
}
