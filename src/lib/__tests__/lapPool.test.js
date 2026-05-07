// Tests for the LAP pool (Path A — Tier-3 default passive LP).

import { describe, it, expect } from "vitest";
import {
  initLapPoolState,
  poolStake,
  totalActiveNotional,
  poolUtilization,
  underwriterStake,
  voluntaryStakeOf,
  threadDerivedStakeOf,
  depositUnderwriter,
  withdrawUnderwriter,
  adjustThreadDerived,
  absorbImbalance,
  distributeRebate,
  calcContractPoolPnl,
  markToMarket,
  closeAbsorbed,
  maintainAbsorbed,
} from "../lapPool.js";

// ---------------------------------------------------------------------------
// State factory + accessors
// ---------------------------------------------------------------------------

describe("initLapPoolState", () => {
  it("returns an empty pool with zero stake", () => {
    const s = initLapPoolState();
    expect(s.totalStake).toBe(0);
    expect(s.activeAbsorbed).toEqual([]);
    expect(s.cumulativeRebateIncome).toBe(0);
    expect(s.cumulativePoolPnl).toBe(0);
    expect(s.contractCount).toBe(0);
    expect(poolStake(s)).toBe(0);
    expect(totalActiveNotional(s)).toBe(0);
    expect(poolUtilization(s)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Voluntary deposit / withdraw with lockup
// ---------------------------------------------------------------------------

describe("depositUnderwriter / withdrawUnderwriter", () => {
  it("accepts a positive deposit and increments totalStake", () => {
    const s0 = initLapPoolState();
    const r = depositUnderwriter({ state: s0, uid: "A", amount: 1000, currentEpoch: 0 });
    expect(r.ok).toBe(true);
    expect(r.state.totalStake).toBe(1000);
    expect(voluntaryStakeOf(r.state, "A")).toBe(1000);
    expect(threadDerivedStakeOf(r.state, "A")).toBe(0);
    expect(underwriterStake(r.state, "A")).toBe(1000);
  });

  it("rejects zero or negative deposits", () => {
    const s0 = initLapPoolState();
    expect(depositUnderwriter({ state: s0, uid: "A", amount: 0 }).ok).toBe(false);
    expect(depositUnderwriter({ state: s0, uid: "A", amount: -1 }).ok).toBe(false);
    expect(depositUnderwriter({ state: s0, uid: "", amount: 100 }).ok).toBe(false);
  });

  it("respects lockup until release epoch", () => {
    let s = initLapPoolState();
    s = depositUnderwriter({ state: s, uid: "A", amount: 500, currentEpoch: 10 }).state;
    // BBOOK_LOCKUP_EPOCHS is 100 ticks; release at 110.
    const blocked = withdrawUnderwriter({
      state: s,
      uid: "A",
      amount: 100,
      currentEpoch: 50,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.reason).toMatch(/locked/);
  });

  it("allows withdrawal after lockup release", () => {
    let s = initLapPoolState();
    s = depositUnderwriter({ state: s, uid: "A", amount: 500, currentEpoch: 0 }).state;
    const ok = withdrawUnderwriter({
      state: s,
      uid: "A",
      amount: 200,
      currentEpoch: 200,
    });
    expect(ok.ok).toBe(true);
    expect(voluntaryStakeOf(ok.state, "A")).toBe(300);
    expect(ok.state.totalStake).toBe(300);
  });

  it("cannot withdraw thread-derived stake via voluntary path", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "A", delta: 1000 }).state;
    // No voluntary stake yet. Withdraw should reject.
    const r = withdrawUnderwriter({
      state: s,
      uid: "A",
      amount: 100,
      currentEpoch: 200,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/voluntary/);
  });
});

// ---------------------------------------------------------------------------
// Thread-derived stake (the default Path-A route)
// ---------------------------------------------------------------------------

describe("adjustThreadDerived", () => {
  it("adds thread-derived stake without lockup constraints", () => {
    const s0 = initLapPoolState();
    const r = adjustThreadDerived({ state: s0, uid: "A", delta: 800 });
    expect(r.ok).toBe(true);
    expect(threadDerivedStakeOf(r.state, "A")).toBe(800);
    expect(r.state.totalStake).toBe(800);
  });

  it("subtracts thread-derived stake on negative delta", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "A", delta: 1000 }).state;
    const r = adjustThreadDerived({ state: s, uid: "A", delta: -300 });
    expect(r.ok).toBe(true);
    expect(threadDerivedStakeOf(r.state, "A")).toBe(700);
    expect(r.state.totalStake).toBe(700);
  });

  it("rejects negative delta exceeding existing thread-derived stake", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "A", delta: 100 }).state;
    const r = adjustThreadDerived({ state: s, uid: "A", delta: -500 });
    expect(r.ok).toBe(false);
  });

  it("removes the underwriter record when total drops to zero", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "A", delta: 100 }).state;
    s = adjustThreadDerived({ state: s, uid: "A", delta: -100 }).state;
    expect(s.underwriters?.A).toBeUndefined();
    expect(s.totalStake).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// absorbImbalance — the pool's primary economic role
// ---------------------------------------------------------------------------

describe("absorbImbalance", () => {
  function setup() {
    let s = initLapPoolState();
    // Pool has $10k stake.
    s = adjustThreadDerived({ state: s, uid: "POOL_LP", delta: 10000 }).state;
    return s;
  }

  it("absorbs unmatched longs and earns the entropy-rebate tip", () => {
    const s = setup();
    // Two unmatched long bids; pool takes the SHORT side.
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 2, tip_tiers: [{ tip: 0.02 }] },
        { id: "U2", base_margin: 500, max_lev: 3, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      normWeights: [1, 1, 1],
      bucketLevs: [1, 2, 3],
      openPrice: 100,
      currentEpoch: 50,
      rebateBudget: 1_000,
    });
    expect(r.absorbedContracts).toHaveLength(2);
    // Pool sides should all be SHORT (opposite of unmatched longs).
    for (const c of r.absorbedContracts) {
      expect(c.side).toBe("SHORT");
    }
    // Tip received = margin × 0.02 each.
    expect(r.totalRebate).toBeCloseTo(1000 * 0.02 + 500 * 0.02);
    expect(r.state.cumulativeRebateIncome).toBeCloseTo(r.totalRebate);
    expect(r.state.contractCount).toBe(2);
  });

  it("absorbs unmatched shorts on the LONG side", () => {
    const s = setup();
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [],
      unmatchedShorts: [
        { id: "U1", base_margin: 1000, max_lev: 2, tip_tiers: [{ tip: 0.02 }] },
      ],
      normWeights: [1],
      bucketLevs: [2],
      openPrice: 100,
      currentEpoch: 1,
      rebateBudget: 1_000,
    });
    expect(r.absorbedContracts).toHaveLength(1);
    expect(r.absorbedContracts[0].side).toBe("LONG");
  });

  it("respects the capacity gate (BBOOK_MAX_NOTIONAL_RATIO = 1.5)", () => {
    let s = initLapPoolState();
    // Pool has $1000 stake. Capacity = $1500 notional.
    s = adjustThreadDerived({ state: s, uid: "POOL_LP", delta: 1000 }).state;
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [
        // First bid: $1000 × 1× = $1000 notional. OK.
        { id: "U1", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
        // Second bid: $1000 × 1× = $1000 notional. Total would be $2000,
        // exceeds $1500 cap. Should be skipped.
        { id: "U2", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      normWeights: [1],
      bucketLevs: [1],
      openPrice: 100,
      rebateBudget: 1_000,
    });
    expect(r.absorbedContracts).toHaveLength(1);
    expect(r.absorbedContracts[0].absorbedUserId).toBe("U1");
  });

  it("returns no-op when there's no unmatched flow", () => {
    const s = setup();
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [],
      unmatchedShorts: [],
      openPrice: 100,
    });
    expect(r.absorbedContracts).toHaveLength(0);
    expect(r.totalRebate).toBe(0);
    expect(r.state).toBe(s); // unchanged
  });

  it("returns no-op when the pool has no stake", () => {
    const s = initLapPoolState();
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [{ id: "U1", base_margin: 100, max_lev: 1, tip_tiers: [{ tip: 0.02 }] }],
      unmatchedShorts: [],
      openPrice: 100,
    });
    expect(r.absorbedContracts).toHaveLength(0);
  });

  it("applies the entropy multiplier to the tip rate", () => {
    const s = setup();
    // Bid leverage 2; bucket 2 has weight = 2.0 (2× the average).
    // entMult = 2.0 / avg(1, 2, 1) = 2.0 / 1.333 ≈ 1.5
    const r = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 2, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      normWeights: [1, 2, 1],
      bucketLevs: [1, 2, 3],
      openPrice: 100,
      rebateBudget: 1_000,
    });
    // tip = 0.02 × 1.5 = 0.03 → rebate = 1000 × 0.03 = 30
    expect(r.totalRebate).toBeCloseTo(30, 1);
  });
});

// ---------------------------------------------------------------------------
// distributeRebate
// ---------------------------------------------------------------------------

describe("distributeRebate", () => {
  it("distributes pro-rata to LP stakes and increases stake balances", () => {
    let s = initLapPoolState();
    // A has $600 voluntary; B has $400 thread-derived. Total $1000.
    s = depositUnderwriter({ state: s, uid: "A", amount: 600, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "B", delta: 400 }).state;
    const r = distributeRebate({ state: s, totalRebate: 100 });
    expect(r.lpShares.A.total).toBeCloseTo(60);
    expect(r.lpShares.A.voluntary).toBeCloseTo(60);
    expect(r.lpShares.A.threadDerived).toBeCloseTo(0);
    expect(r.lpShares.B.total).toBeCloseTo(40);
    expect(r.lpShares.B.voluntary).toBeCloseTo(0);
    expect(r.lpShares.B.threadDerived).toBeCloseTo(40);
    // Total stake grew by the rebate.
    expect(r.state.totalStake).toBeCloseTo(1100);
  });

  it("is a no-op when rebate is zero or negative", () => {
    const s = initLapPoolState();
    expect(distributeRebate({ state: s, totalRebate: 0 }).state).toBe(s);
    expect(distributeRebate({ state: s, totalRebate: -1 }).state).toBe(s);
  });

  it("is a no-op when there are no stakeholders", () => {
    const s = initLapPoolState();
    const r = distributeRebate({ state: s, totalRebate: 100 });
    expect(r.lpShares).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// calcContractPoolPnl + markToMarket + closeAbsorbed
// ---------------------------------------------------------------------------

describe("calcContractPoolPnl", () => {
  it("pool gains when its absorbed-SHORT moves favourably (price drops)", () => {
    const c = {
      side: "SHORT",
      leverage: 2,
      margin: 1000,
      openPrice: 100,
    };
    expect(calcContractPoolPnl(c, 95)).toBeGreaterThan(0); // price down → short wins
    expect(calcContractPoolPnl(c, 105)).toBeLessThan(0); // price up → short loses
  });

  it("caps loss at absorbed user's margin", () => {
    const c = {
      side: "LONG",
      leverage: 10,
      margin: 100,
      openPrice: 100,
    };
    // Massive adverse move shouldn't push loss beyond -margin.
    expect(calcContractPoolPnl(c, 50)).toBeGreaterThanOrEqual(-100);
  });

  it("zero P&L at the open price", () => {
    const c = {
      side: "SHORT",
      leverage: 2,
      margin: 1000,
      openPrice: 100,
    };
    expect(calcContractPoolPnl(c, 100)).toBe(0);
  });
});

describe("markToMarket", () => {
  it("aggregates unrealised P&L across active absorbed contracts", () => {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "POOL_LP", delta: 10000 }).state;
    s = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 2, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
        { id: "U2", base_margin: 500, max_lev: 1, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 1_000,
    }).state;
    // Both pool positions are SHORT. Price drops → both pool positions gain.
    const r = markToMarket({ state: s, pricesByPair: { BTCUSD: 95 } });
    expect(r.byContract).toHaveLength(2);
    expect(r.totalUnrealizedPoolPnl).toBeGreaterThan(0);
  });
});

describe("closeAbsorbed", () => {
  it("realises P&L and distributes pro-rata", () => {
    let s = initLapPoolState();
    s = depositUnderwriter({ state: s, uid: "A", amount: 3000, currentEpoch: 0 }).state;
    s = adjustThreadDerived({ state: s, uid: "B", delta: 2000 }).state;
    s = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 2, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 1_000,
    }).state;
    const contractId = s.activeAbsorbed[0].id;
    // Pool side is SHORT. Close at 95 (favourable) → poolPnl > 0.
    const r = closeAbsorbed({ state: s, contractId, currentPrice: 95 });
    expect(r.ok).toBe(true);
    expect(r.poolPnl).toBeGreaterThan(0);
    // 60% to A, 40% to B.
    expect(r.underwriterShares.A.total).toBeCloseTo(r.poolPnl * 0.6);
    expect(r.underwriterShares.B.total).toBeCloseTo(r.poolPnl * 0.4);
    expect(r.state.activeAbsorbed).toHaveLength(0);
    expect(r.state.cumulativePoolPnl).toBeCloseTo(r.poolPnl);
  });

  it("rejects close on a non-existent contract", () => {
    const s = initLapPoolState();
    const r = closeAbsorbed({ state: s, contractId: "nope", currentPrice: 100 });
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Conservation: rebate distribution + close P&L net to zero across LPs
// ---------------------------------------------------------------------------

describe("conservation across rebate + close", () => {
  it("rebate distribution + closeAbsorbed P&L sums match cumulative tracking", () => {
    let s = initLapPoolState();
    s = depositUnderwriter({ state: s, uid: "A", amount: 1000, currentEpoch: 0 }).state;
    const absorb = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 500, max_lev: 1, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 1_000,
    });
    s = absorb.state;
    const rebate = absorb.totalRebate;
    const dist = distributeRebate({ state: s, totalRebate: rebate });
    s = dist.state;
    const totalDistributed = Object.values(dist.lpShares).reduce(
      (sum, x) => sum + x.total,
      0
    );
    expect(totalDistributed).toBeCloseTo(rebate, 6);

    const contractId = s.activeAbsorbed[0].id;
    const closed = closeAbsorbed({ state: s, contractId, currentPrice: 100 });
    expect(closed.ok).toBe(true);
    // At open price → pnl = 0; only rebate ended up flowing.
    expect(closed.poolPnl).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rebate budget cap — conservation gate
// ---------------------------------------------------------------------------

describe("absorbImbalance rebate budget", () => {
  function setup() {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "POOL_LP", delta: 10000 }).state;
    return s;
  }

  it("absorbs nothing when rebateBudget is zero", () => {
    const r = absorbImbalance({
      state: setup(),
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 0,
    });
    expect(r.absorbedContracts).toHaveLength(0);
    expect(r.totalRebate).toBe(0);
  });

  it("stops absorbing once accumulated tip would exceed the budget", () => {
    // Each bid earns $20 tip ($1000 × 0.02). Budget $25 → only first bid
    // absorbed, second skipped.
    const r = absorbImbalance({
      state: setup(),
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
        { id: "U2", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 25,
    });
    expect(r.absorbedContracts).toHaveLength(1);
    expect(r.totalRebate).toBeCloseTo(20);
  });

  it("rebateRequested reflects what would have been earned with infinite budget", () => {
    const r = absorbImbalance({
      state: setup(),
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
        { id: "U2", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }] },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      rebateBudget: 25,
    });
    // Funded only $20; would-have-been $40.
    expect(r.totalRebate).toBeCloseTo(20);
    expect(r.rebateRequested).toBeCloseTo(40);
  });
});

// ---------------------------------------------------------------------------
// maintainAbsorbed — per-tick aged-contract close pass
// ---------------------------------------------------------------------------

describe("maintainAbsorbed", () => {
  function withAbsorbed({ openedAtEpoch = 0 } = {}) {
    let s = initLapPoolState();
    s = adjustThreadDerived({ state: s, uid: "LP", delta: 10000 }).state;
    s = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U1", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      currentEpoch: openedAtEpoch,
      rebateBudget: 1_000,
    }).state;
    return s;
  }

  it("is a no-op when no contracts are aged", () => {
    const s = withAbsorbed({ openedAtEpoch: 0 });
    const r = maintainAbsorbed({
      state: s,
      pricesByPair: { BTCUSD: 100 },
      currentEpoch: 5, // < holdEpochs
      maxHoldEpochs: 10,
    });
    expect(r.closed).toHaveLength(0);
    expect(r.state).toBe(s);
  });

  it("closes contracts past the hold window and returns underwriter shares", () => {
    const s = withAbsorbed({ openedAtEpoch: 0 });
    const r = maintainAbsorbed({
      state: s,
      pricesByPair: { BTCUSD: 100 },
      currentEpoch: 20,
      maxHoldEpochs: 10,
    });
    expect(r.closed).toHaveLength(1);
    expect(r.closed[0].reason).toBe("aged");
    expect(r.closed[0].underwriterShares).toBeDefined();
    expect(r.state.activeAbsorbed).toHaveLength(0);
  });

  it("skips contracts whose pair has no current price", () => {
    const s = withAbsorbed({ openedAtEpoch: 0 });
    const r = maintainAbsorbed({
      state: s,
      pricesByPair: {}, // no BTCUSD price
      currentEpoch: 20,
      maxHoldEpochs: 10,
    });
    expect(r.closed).toHaveLength(0);
    expect(r.state.activeAbsorbed).toHaveLength(1);
  });

  it("aggregates realised P&L across multiple aged contracts", () => {
    let s = withAbsorbed({ openedAtEpoch: 0 });
    s = absorbImbalance({
      state: s,
      unmatchedLongs: [
        { id: "U2", base_margin: 1000, max_lev: 1, tip_tiers: [{ tip: 0.02 }], activePair: "BTCUSD" },
      ],
      unmatchedShorts: [],
      openPrice: 100,
      currentEpoch: 0,
      rebateBudget: 1_000,
    }).state;
    // Close at OPEN price → pnl = 0 for both. Sanity: both close, sum is 0.
    const r = maintainAbsorbed({
      state: s,
      pricesByPair: { BTCUSD: 100 },
      currentEpoch: 20,
      maxHoldEpochs: 10,
    });
    expect(r.closed).toHaveLength(2);
    expect(r.totalRealizedPnl).toBeCloseTo(0);
    expect(r.state.activeAbsorbed).toHaveLength(0);
  });
});
