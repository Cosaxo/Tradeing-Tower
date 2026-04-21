// First-run tutorial overlay. Steps through the key mechanics.
import { useState } from "react";

const STEPS = [
  {
    title: "Welcome to Trading Tower",
    body:
      "An ESMA-compliant leveraged auction simulator. Prices tick every second, auctions clear every ~6s, and analytics refresh every ~30s. You play a trader alongside 5 NPCs with distinct strategies.",
  },
  {
    title: "Geodesic Distribution",
    body:
      "Instead of an orderbook, the clearinghouse builds a bimodal log-normal leverage distribution. The faint line is the ideal fill; the solid line is the actual fill. KL divergence between them drives entropy weights.",
  },
  {
    title: "Entropy-Weighted Yield",
    body:
      "If a leverage bucket is under-supplied, filling it earns a yield premium. Thin buckets pay more. This self-routes liquidity to where the book is shallow.",
  },
  {
    title: "Counter-Cyclical Insurance Pool",
    body:
      "Deposit into the pool from the Derivatives tab. Crisis epochs (high KL divergence) pay depositors 1×–3× the base rate — the worse the book, the more you earn for staying in.",
  },
  {
    title: "Credit System",
    body:
      "Consistent risk-adjusted returns (Sortino, Calmar, Win Rate, low Max DD) extend your leverage cap beyond ESMA. Diversified, hedged books score higher.",
  },
  {
    title: "Ready",
    body:
      "Press Space (or the START button) to begin. Use 1-9 for tabs, +/- for speed, R to reset. The ? icons explain jargon in context.",
  },
];

const KEY = "tt.tutorial.seen";

export function Tutorial({ force = false, onClose }) {
  const seen = (() => {
    try {
      return window.localStorage.getItem(KEY) === "1";
    } catch {
      return false;
    }
  })();

  const [open, setOpen] = useState(force || !seen);
  const [step, setStep] = useState(0);

  function close() {
    try {
      window.localStorage.setItem(KEY, "1");
    } catch {
      /* ignore */
    }
    setOpen(false);
    onClose?.();
  }

  if (!open) return null;

  const cur = STEPS[step];
  const last = step === STEPS.length - 1;

  return (
    <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
      <div className="max-w-lg w-full rounded border border-indigo-700 bg-gray-900 p-5 flex flex-col gap-4 shadow-2xl">
        <div className="flex items-center justify-between">
          <span className="font-syne text-lg text-indigo-300">{cur.title}</span>
          <span className="text-[10px] font-mono text-gray-500">
            {step + 1} / {STEPS.length}
          </span>
        </div>

        <p className="text-[12px] font-mono text-gray-300 leading-relaxed">
          {cur.body}
        </p>

        {/* Step dots */}
        <div className="flex items-center gap-1">
          {STEPS.map((_, i) => (
            <button
              key={i}
              onClick={() => setStep(i)}
              className={`h-1.5 rounded-full transition-all ${
                i === step ? "w-6 bg-indigo-400" : "w-2 bg-gray-700 hover:bg-gray-600"
              }`}
            />
          ))}
        </div>

        <div className="flex items-center justify-between">
          <button
            onClick={close}
            className="text-[10px] font-mono text-gray-500 hover:text-gray-300"
          >
            skip
          </button>
          <div className="flex items-center gap-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="text-xs font-mono px-3 py-1 rounded border border-gray-700 bg-gray-800 text-gray-300 hover:border-gray-500"
              >
                back
              </button>
            )}
            <button
              onClick={() => (last ? close() : setStep((s) => s + 1))}
              className="text-xs font-mono px-3 py-1 rounded border border-indigo-600 bg-indigo-950 text-indigo-200 hover:bg-indigo-900"
            >
              {last ? "Start" : "next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
