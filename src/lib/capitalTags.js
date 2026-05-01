// Same-capital principle.
//
// Capital does not move between floors. It accumulates roles. The same
// dollar of margin can simultaneously be tagged as:
//
//   - poolDeposit    (loose insurance-market allocation, no TT thread)
//   - auctionMargin  (backing an open LAP position)
//   - threadStake    (locked into a Tower Tether thread — same dollar
//                     covers the T-bill, insurance fill, paired LAP,
//                     and minted TT simultaneously; released only when
//                     the thread is redeemed or fully damaged)
//   - bBookStake     (deposited as B-book underwriter capital — earns
//                     B-classified user tip flow + absorbs their
//                     directional P&L)
//
// Margin itself changes only through real cash flows: tips, P&L,
// premiums, payouts. Tagging is a pure claim operation — no margin
// is transferred.
//
// Stacking is safe because each role's claim is bounded and the sum
// of tagged amounts is guarded by `freeMargin`.

export const TAG_KEYS = ["poolDeposit", "auctionMargin", "threadStake", "bBookStake"];

export const TAG_LABELS = {
  poolDeposit: "Pool Collateral",
  auctionMargin: "Auction Margin",
  threadStake: "TT Thread",
  bBookStake: "B-book Underwriter",
};

export const TAG_COLORS = {
  poolDeposit: "#a78bfa",
  auctionMargin: "#34d399",
  threadStake: "#fbbf24",
  bBookStake: "#f472b6",
};

export function initTags() {
  return Object.fromEntries(TAG_KEYS.map((k) => [k, 0]));
}

// Sum of all tagged portions — the "claimed" fraction of margin.
export function totalTagged(tags) {
  if (!tags) return 0;
  return TAG_KEYS.reduce((s, k) => s + (tags[k] ?? 0), 0);
}

// Free (un-tagged) margin available for new role assignments.
export function freeMargin(margin, tags) {
  return Math.max(0, (margin ?? 0) - totalTagged(tags));
}

// Try to add `amount` to tag `key`. Returns new tags object if feasible,
// otherwise null (caller decides how to surface the failure).
export function tryTag(margin, tags, key, amount) {
  if (amount < 0) {
    // Untagging: always allowed, but clamped to >= 0.
    return { ...tags, [key]: Math.max(0, (tags[key] ?? 0) + amount) };
  }
  if (freeMargin(margin, tags) < amount) return null;
  return { ...tags, [key]: (tags[key] ?? 0) + amount };
}

// Untag without constraint check (e.g. closing a position or cancelling an offer).
export function untag(tags, key, amount) {
  return { ...tags, [key]: Math.max(0, (tags[key] ?? 0) - amount) };
}

// Shrink all tags proportionally when margin falls below total tagged.
// Called after a big loss so that tag invariant holds without manual cleanup.
export function normalizeTags(margin, tags) {
  const total = totalTagged(tags);
  if (total <= margin) return tags;
  if (total === 0) return tags;
  const scale = margin / total;
  return Object.fromEntries(TAG_KEYS.map((k) => [k, (tags[k] ?? 0) * scale]));
}
