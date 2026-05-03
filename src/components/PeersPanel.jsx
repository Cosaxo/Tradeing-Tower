// PeersPanel — replaces the legacy NpcPanel.
//
// Shows connected peers in the current room (other browser tabs sharing
// the BroadcastChannel). Each row is one real human user broadcasting
// their bid.
//
// Empty state explicitly tells solo users to open another tab to see
// multi-user trading — this is the core demo loop.

export function PeersPanel({ peers = [], peerCount = 0, roomId = "default" }) {
  return (
    <div className="rounded border border-gray-800 bg-gray-900 p-2 flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[11px] font-mono text-gray-300 uppercase">
          Room · <span className="text-indigo-300">{roomId}</span>
        </span>
        <span className="text-[10px] font-mono text-gray-500">
          {peerCount === 0 ? "solo" : `${peerCount} peer${peerCount === 1 ? "" : "s"}`}
        </span>
      </div>

      {peers.length === 0 ? (
        <div className="text-[10px] font-mono text-gray-500 leading-relaxed py-1">
          No other users in this room. Open another tab to add a peer —
          their bids will appear here and your auctions will match
          against them.
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          {peers.map((p) => (
            <div
              key={p.id}
              className="flex items-center gap-2 text-[10px] font-mono px-1 py-0.5 rounded bg-gray-950"
            >
              <span className="text-indigo-300 truncate flex-1">{p.id}</span>
              <span
                className={
                  p.side === "SHORT" ? "text-red-300" : "text-emerald-300"
                }
              >
                {p.side ?? "—"}
              </span>
              <span className="text-amber-300">
                {Number.isFinite(p.leverage) ? `${p.leverage.toFixed(1)}×` : "—"}
              </span>
              <span className="text-gray-400">
                {Number.isFinite(p.margin) ? `$${p.margin.toFixed(0)}` : "—"}
              </span>
              <span className="text-gray-600 truncate max-w-[60px]">
                {p.pairKey ?? "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
