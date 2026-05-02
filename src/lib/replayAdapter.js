// ReplayAdapter — deterministic playback of a recorded order-flow tape.
//
// Use cases:
//   - Backtest: drive the engine against historical flow recorded
//     from a real broker / market data source.
//   - Property tests: run protocol stress tests against a fixed
//     scenario, asserting mechanism properties (entropy convergence,
//     conservation invariants, etc.) without RNG noise.
//   - Repro a bug: capture a session, replay it, debug deterministically.
//
// Tape format: an array of frames keyed by (epoch, pairKey).
//
//   [
//     {
//       epoch: 0,
//       pairKey: "BTCUSD",
//       participants: [{ id, strategy, base_margin, max_lev, tip_tiers, ... }],
//       poolUsers:    [{ id, margin, leverage, side }],
//       rentalBids:   [{ id, bidderId, pairKey, maxTipRate, rentalMargin, ... }],
//     },
//     ...
//   ]
//
// On each tick, the adapter looks up the matching frame for
// (epoch, pairKey) and returns its contents directly. Missing frames
// yield empty flow (auction/pool both no-ops for that pair-tick).
//
// The adapter is a pure replay — applySettlement is a no-op since
// the tape's poolUsers are pre-determined. detectLiquidations and
// markRestocked also no-op.

import { isValidAuctionBid, isValidPoolUser, isValidRentalBid, filterValid } from "./orderFlow.js";

export function createReplayAdapter({ tape = [] } = {}) {
  // Index by (epoch, pairKey) for O(1) lookup per tick.
  const index = new Map();
  for (const frame of tape) {
    if (!Number.isFinite(frame?.epoch) || typeof frame?.pairKey !== "string") {
      continue; // skip malformed frame
    }
    const key = `${frame.epoch}::${frame.pairKey}`;
    index.set(key, frame);
  }

  return {
    run({ pairKey, epoch }) {
      const frame = index.get(`${epoch}::${pairKey}`);
      if (!frame) {
        return { participants: [], poolUsers: [], rentalBids: [], snapshot: [] };
      }
      // Re-run guards even though the index was loaded once — defends
      // against tapes mutated in place after init.
      const { valid: participants } = filterValid(frame.participants ?? [], isValidAuctionBid);
      const { valid: poolUsers } = filterValid(frame.poolUsers ?? [], isValidPoolUser);
      const { valid: rentalBids } = filterValid(frame.rentalBids ?? [], isValidRentalBid);
      return {
        participants,
        poolUsers,
        rentalBids,
        snapshot: frame.snapshot ?? [],
      };
    },

    // Replay is purely read-only; settlement results don't feed back.
    applySettlement() {
      // intentional no-op
    },
    markRestockedFromSnapshot() {
      return [];
    },
    detectLiquidationsFromSnapshot() {
      return [];
    },
    getSnapshot() {
      return [];
    },
  };
}
