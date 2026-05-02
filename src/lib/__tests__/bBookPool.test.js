import { describe, it, expect } from "vitest";
import {
  initBBookState,
  depositUnderwriter,
  withdrawUnderwriter,
  adjustThreadDerived,
  openContract,
  closeContract,
  calcContractUserPnl,
  markToMarket,
  matchBBookBids,
  poolStake,
  poolUtilization,
  totalActiveNotional,
  underwriterStake,
  voluntaryStakeOf,
  threadDerivedStakeOf,
  activeContractsByUser,
} from "../bBookPool.js";
import {
  BBOOK_MAX_NOTIONAL_RATIO,
  BBOOK_LOCKUP_EPOCHS,
} from "../../constants/system.js";

// ---------------------------------------------------------------------------
// state
// ---------------------------------------------------------------------------

describe("initBBookState", () => {
  it("starts empty", () => {
    const s = initBBookState();
    expect(poolStake(s)).toBe(0);
    expect(s.activeContracts).toEqual([]);
    expect(s.underwriters).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// underwriters
// ---------------------------------------------------------------------------

describe("depositUnderwriter / withdrawUnderwriter", () => {
  it("adds stake and totals", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 1000, currentEpoch: 0 }).state;
    expect(poolStake(s)).toBe(1000);
    expect(underwriterStake(s, "U1")).toBe(1000);
  });

  it("rejects non-positive amounts", () => {
    const s = initBBookState();
    expect(depositUnderwriter({ state: s, uid: "U1", amount: 0 }).ok).toBe(false);
    expect(depositUnderwriter({ state: s, uid: "U1", amount: -10 }).ok).toBe(false);
  });

  it("blocks withdrawal during lockup", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 1000, currentEpoch: 0 }).state;
    const r = withdrawUnderwriter({
      state: s,
      uid: "U1",
      amount: 100,
      currentEpoch: 5,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/locked/);
  });

  it("allows withdrawal after lockup", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 1000, currentEpoch: 0 }).state;
    const r = withdrawUnderwriter({
      state: s,
      uid: "U1",
      amount: 300,
      currentEpoch: BBOOK_LOCKUP_EPOCHS + 1,
    });
    expect(r.ok).toBe(true);
    expect(poolStake(r.state)).toBe(700);
    expect(underwriterStake(r.state, "U1")).toBe(700);
  });

  it("re-deposit pushes lockup release further out", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 500, currentEpoch: 0 }).state;
    s = depositUnderwriter({ state: s, uid: "U1", amount: 500, currentEpoch: 50 }).state;
    expect(s.underwriters.U1.lockupReleaseEpoch).toBe(50 + BBOOK_LOCKUP_EPOCHS);
  });

  it("withdraw drops underwriter entry when stake hits zero", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 1000, currentEpoch: 0 }).state;
    s = withdrawUnderwriter({
      state: s,
      uid: "U1",
      amount: 1000,
      currentEpoch: BBOOK_LOCKUP_EPOCHS + 1,
    }).state;
    expect(s.underwriters.U1).toBeUndefined();
    expect(poolStake(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// adjustThreadDerived (thread-funded stake portion)
// ---------------------------------------------------------------------------

describe("adjustThreadDerived", () => {
  it("adds thread-derived stake without lockup", () => {
    let s = initBBookState();
    const r = adjustThreadDerived({ state: s, uid: "U1", delta: 1000 });
    expect(r.ok).toBe(true);
    expect(threadDerivedStakeOf(r.state, "U1")).toBe(1000);
    expect(voluntaryStakeOf(r.state, "U1")).toBe(0);
    expect(poolStake(r.state)).toBe(1000);
  });

  it("withdrawal (delta < 0) reduces thread-derived stake", () => {
    let s = initBBookState();
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 1000 }).state;
    const r = adjustThreadDerived({ state: s, uid: "U1", delta: -300 });
    expect(r.ok).toBe(true);
    expect(threadDerivedStakeOf(r.state, "U1")).toBe(700);
  });

  it("rejects negative delta exceeding thread-derived stake", () => {
    let s = initBBookState();
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 100 }).state;
    const r = adjustThreadDerived({ state: s, uid: "U1", delta: -1000 });
    expect(r.ok).toBe(false);
  });

  it("does NOT impose any lockup on thread-derived withdrawals", () => {
    let s = initBBookState();
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 1000 }).state;
    // Lockup epoch hasn't passed but thread-derived can still be withdrawn.
    const r = adjustThreadDerived({ state: s, uid: "U1", delta: -500 });
    expect(r.ok).toBe(true);
  });

  it("co-exists with voluntaryStake in totalStake", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 500, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 700 }).state;
    expect(voluntaryStakeOf(s, "U1")).toBe(500);
    expect(threadDerivedStakeOf(s, "U1")).toBe(700);
    expect(underwriterStake(s, "U1")).toBe(1200);
    expect(poolStake(s)).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// withdrawUnderwriter only operates on voluntary
// ---------------------------------------------------------------------------

describe("withdrawUnderwriter (voluntary only)", () => {
  it("rejects when amount exceeds voluntary stake even if total is sufficient", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 100, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 1000 }).state;
    const r = withdrawUnderwriter({
      state: s,
      uid: "U1",
      amount: 500, // > voluntary (100), but < total (1100)
      currentEpoch: BBOOK_LOCKUP_EPOCHS + 1,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/voluntary stake/);
  });

  it("withdraws from voluntary while leaving thread-derived intact", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 200, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 800 }).state;
    const r = withdrawUnderwriter({
      state: s,
      uid: "U1",
      amount: 150,
      currentEpoch: BBOOK_LOCKUP_EPOCHS + 1,
    });
    expect(r.ok).toBe(true);
    expect(voluntaryStakeOf(r.state, "U1")).toBe(50);
    expect(threadDerivedStakeOf(r.state, "U1")).toBe(800);
    expect(poolStake(r.state)).toBe(850);
  });
});

// ---------------------------------------------------------------------------
// open / close contract
// ---------------------------------------------------------------------------

function seedPool(stake = 10000) {
  return depositUnderwriter({
    state: initBBookState(),
    uid: "U1",
    amount: stake,
    currentEpoch: 0,
  }).state;
}

describe("openContract", () => {
  it("rejects when pool has no stake", () => {
    const r = openContract({
      state: initBBookState(),
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    });
    expect(r.ok).toBe(false);
  });

  it("opens a contract and records it", () => {
    const r = openContract({
      state: seedPool(),
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 500,
      openPrice: 100,
      currentEpoch: 1,
    });
    expect(r.ok).toBe(true);
    expect(r.state.activeContracts).toHaveLength(1);
    expect(r.contract.userId).toBe("Alice");
    expect(r.contract.side).toBe("LONG");
    expect(r.contract.leverage).toBe(2);
  });

  it("refuses when notional would exceed pool capacity", () => {
    // pool stake 1000 → max notional = 1500 at MAX_NOTIONAL_RATIO=1.5
    const s = seedPool(1000);
    // 800 × 5 = 4000 > 1500 → reject
    const r = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 5,
      margin: 800,
      openPrice: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/capacity/);
  });

  it("notional capacity matches the configured ratio", () => {
    const s = seedPool(1000);
    // Notional = stake × ratio exactly
    const ok = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 1,
      margin: 1000 * BBOOK_MAX_NOTIONAL_RATIO,
      openPrice: 100,
    });
    expect(ok.ok).toBe(true);
  });
});

describe("calcContractUserPnl", () => {
  const c = {
    side: "LONG",
    leverage: 2,
    margin: 100,
    openPrice: 100,
  };

  it("flat price ⇒ zero P&L", () => {
    expect(calcContractUserPnl(c, 100)).toBeCloseTo(0);
  });

  it("price up on long ⇒ positive P&L (exp form)", () => {
    // 100 × 2 × (e^ln(1.10) - 1) = 200 × 0.10 = 20
    expect(calcContractUserPnl(c, 110)).toBeCloseTo(20, 5);
  });

  it("short side mirrors", () => {
    const cs = { ...c, side: "SHORT" };
    expect(calcContractUserPnl(cs, 90)).toBeCloseTo(
      100 * 2 * (Math.exp(-Math.log(0.9)) - 1),
      5
    );
  });

  it("loss is capped at margin (no negative balance)", () => {
    // Hypothetical 90% drop on a 5x long
    const c5 = { side: "LONG", leverage: 5, margin: 100, openPrice: 100 };
    const pnl = calcContractUserPnl(c5, 10);
    expect(pnl).toBeGreaterThanOrEqual(-100);
  });
});

describe("closeContract", () => {
  it("closes a winning user contract; pool/underwriters lose", () => {
    let s = seedPool(10000);
    const opened = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    });
    s = opened.state;
    const r = closeContract({ state: s, contractId: opened.contract.id, currentPrice: 110 });
    expect(r.ok).toBe(true);
    expect(r.userPnl).toBeCloseTo(20, 5);
    expect(r.poolPnl).toBeCloseTo(-20, 5);
    expect(poolStake(r.state)).toBeCloseTo(10000 - 20, 5);
    expect(r.state.activeContracts).toHaveLength(0);
  });

  it("closes a losing user contract; pool/underwriters gain", () => {
    let s = seedPool(10000);
    const opened = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    });
    s = opened.state;
    const r = closeContract({ state: s, contractId: opened.contract.id, currentPrice: 90 });
    expect(r.userPnl).toBeLessThan(0);
    expect(r.poolPnl).toBeGreaterThan(0);
    expect(poolStake(r.state)).toBeGreaterThan(10000);
  });

  it("distributes P&L pro-rata across underwriters", () => {
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 8000, currentEpoch: 0 }).state;
    s = depositUnderwriter({ state: s, uid: "U2", amount: 2000, currentEpoch: 0 }).state;
    const opened = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    });
    s = opened.state;
    const r = closeContract({ state: s, contractId: opened.contract.id, currentPrice: 110 });
    // poolPnl = -20 distributed 80/20 — both fully voluntary
    expect(r.underwriterShares.U1.total).toBeCloseTo(-16, 5);
    expect(r.underwriterShares.U1.voluntary).toBeCloseTo(-16, 5);
    expect(r.underwriterShares.U1.threadDerived).toBeCloseTo(0, 5);
    expect(r.underwriterShares.U2.total).toBeCloseTo(-4, 5);
    expect(r.underwriterShares.U2.voluntary).toBeCloseTo(-4, 5);
  });

  it("splits each user's P&L proportionally between voluntary and thread-derived", () => {
    // U1: $4000 voluntary, $4000 thread-derived (50/50 split internally).
    // U2: $2000 voluntary, $0 thread-derived.
    let s = initBBookState();
    s = depositUnderwriter({ state: s, uid: "U1", amount: 4000, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "U1", delta: 4000 }).state;
    s = depositUnderwriter({ state: s, uid: "U2", amount: 2000, currentEpoch: 0 }).state;
    expect(poolStake(s)).toBe(10000);
    const opened = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    });
    s = opened.state;
    const r = closeContract({ state: s, contractId: opened.contract.id, currentPrice: 110 });
    // poolPnl = -20. U1 owns 8000/10000 = 80% → -16; U2 owns 2000/10000 = 20% → -4.
    expect(r.underwriterShares.U1.total).toBeCloseTo(-16, 5);
    // U1's -16 splits 50/50 between voluntary and thread-derived.
    expect(r.underwriterShares.U1.voluntary).toBeCloseTo(-8, 5);
    expect(r.underwriterShares.U1.threadDerived).toBeCloseTo(-8, 5);
    // U2 has no thread-derived — full -4 goes to voluntary.
    expect(r.underwriterShares.U2.voluntary).toBeCloseTo(-4, 5);
    expect(r.underwriterShares.U2.threadDerived).toBeCloseTo(0, 5);
    // Final stakes update both portions.
    expect(voluntaryStakeOf(r.state, "U1")).toBeCloseTo(3992, 5);
    expect(threadDerivedStakeOf(r.state, "U1")).toBeCloseTo(3992, 5);
  });
});

// ---------------------------------------------------------------------------
// markToMarket (read-only)
// ---------------------------------------------------------------------------

describe("markToMarket", () => {
  it("reports unrealized P&L without mutating state", () => {
    let s = seedPool();
    s = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    }).state;
    const m = markToMarket({ state: s, pricesByPair: { BTCUSD: 110 } });
    expect(m.totalUnrealizedUserPnl).toBeCloseTo(20, 5);
    expect(m.totalUnrealizedPoolPnl).toBeCloseTo(-20, 5);
    expect(m.byContract).toHaveLength(1);
    // No state change
    expect(s.activeContracts).toHaveLength(1);
    expect(poolStake(s)).toBe(10000);
  });

  it("ignores contracts whose price isn't supplied", () => {
    let s = seedPool();
    s = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    }).state;
    const m = markToMarket({ state: s, pricesByPair: { ETHUSD: 200 } });
    expect(m.totalUnrealizedUserPnl).toBe(0);
    expect(m.byContract).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// pool capacity / utilisation
// ---------------------------------------------------------------------------

describe("totalActiveNotional / poolUtilization", () => {
  it("sums margin × leverage across active contracts", () => {
    let s = seedPool(10000);
    s = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 500,
      openPrice: 100,
    }).state;
    s = openContract({
      state: s,
      userId: "Bob",
      pairKey: "ETHUSD",
      side: "SHORT",
      leverage: 3,
      margin: 200,
      openPrice: 50,
    }).state;
    expect(totalActiveNotional(s)).toBe(500 * 2 + 200 * 3);
    expect(poolUtilization(s)).toBeCloseTo(1600 / 10000);
  });
});

describe("activeContractsByUser", () => {
  it("filters by userId", () => {
    let s = seedPool();
    s = openContract({
      state: s,
      userId: "Alice",
      pairKey: "BTCUSD",
      side: "LONG",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    }).state;
    s = openContract({
      state: s,
      userId: "Bob",
      pairKey: "BTCUSD",
      side: "SHORT",
      leverage: 2,
      margin: 100,
      openPrice: 100,
    }).state;
    expect(activeContractsByUser(s, "Alice")).toHaveLength(1);
    expect(activeContractsByUser(s, "Bob")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// pre-pool B↔B matching
// ---------------------------------------------------------------------------

describe("matchBBookBids", () => {
  it("pairs B-longs with B-shorts at min leverage and margin", () => {
    const longs = [
      { id: "L1", userId: "Alice", leverage: 2, margin: 100, pairKey: "BTCUSD" },
      { id: "L2", userId: "Bob", leverage: 5, margin: 200, pairKey: "BTCUSD" },
    ];
    const shorts = [
      { id: "S1", userId: "Carol", leverage: 3, margin: 150, pairKey: "BTCUSD" },
      { id: "S2", userId: "Dan", leverage: 4, margin: 100, pairKey: "BTCUSD" },
    ];
    const r = matchBBookBids({ longBids: longs, shortBids: shorts });
    expect(r.matched).toHaveLength(2);
    expect(r.remainingLongs).toHaveLength(0);
    expect(r.remainingShorts).toHaveLength(0);
    // Sorted ascending: longs [2, 5], shorts [3, 4]
    // Pair index 0: 2x ↔ 3x → fillLev 2, margin 100
    // Pair index 1: 5x ↔ 4x → fillLev 4, margin 100
    expect(r.matched[0].leverage).toBe(2);
    expect(r.matched[0].margin).toBe(100);
    expect(r.matched[1].leverage).toBe(4);
    expect(r.matched[1].margin).toBe(100);
  });

  it("leaves excess on the heavier side as remaining", () => {
    const longs = [
      { id: "L1", userId: "A", leverage: 2, margin: 100 },
      { id: "L2", userId: "B", leverage: 3, margin: 100 },
    ];
    const shorts = [{ id: "S1", userId: "C", leverage: 2, margin: 100 }];
    const r = matchBBookBids({ longBids: longs, shortBids: shorts });
    expect(r.matched).toHaveLength(1);
    expect(r.remainingLongs).toHaveLength(1);
  });

  it("empty input is a no-op", () => {
    const r = matchBBookBids({});
    expect(r.matched).toEqual([]);
  });
});
