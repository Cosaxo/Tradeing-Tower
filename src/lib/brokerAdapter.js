// BrokerAdapter — interface stub for live-market wiring.
//
// This is intentionally NOT implemented. It defines the contract a
// real broker integration (Polygon / Alpaca / Binance / IBKR / Kraken
// / ...) would have to satisfy. Implementations belong in a separate
// package or service that owns connection lifecycle, auth, rate
// limiting, retry/backoff, etc.
//
// The contract is the same OrderFlowAdapter shape. A broker adapter
// would:
//
//   - Maintain a streaming connection to the broker's market data + order
//     book feeds (WebSocket / FIX / REST polling, depending on broker).
//   - On each medium-tick run({pairKey, epoch}), drain whatever flow
//     accumulated since the last call into participants / poolUsers /
//     rentalBids.
//   - On applySettlement, optionally forward fill results back to the
//     broker (closing positions, recording margin updates, etc.).
//
// Schema validation at the orderFlow boundary is critical here — the
// broker IS the adversarial-input boundary for this adapter.

export function createBrokerAdapter(_config = {}) {
  return {
    run() {
      throw new Error(
        "BrokerAdapter.run not implemented — use DefaultBotAdapter or ReplayAdapter, " +
          "or provide a concrete broker integration"
      );
    },
    applySettlement() {
      throw new Error("BrokerAdapter.applySettlement not implemented");
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
