import { describe, it, expect } from "vitest";
import {
  initClassifierState,
  recordClose,
  getUserClass,
  getUserScore,
  getUserStats,
  routeFor,
  scoreFromCloses,
  CLASSIFIER_MIN_CLOSES,
  CLASSIFIER_A_THRESHOLD,
  CLASSIFIER_WINDOW,
  WHALE_MARGIN_MULT,
} from "../userClassifier.js";

describe("initClassifierState", () => {
  it("starts empty", () => {
    const s = initClassifierState();
    expect(s.byUser).toEqual({});
  });
});

describe("default B for new users", () => {
  it("getUserClass defaults to B", () => {
    expect(getUserClass(initClassifierState(), "Alice")).toBe("B");
  });

  it("routeFor defaults to B before min closes", () => {
    expect(
      routeFor({
        state: initClassifierState(),
        userId: "Alice",
        positionMargin: 1000,
      })
    ).toBe("B");
  });
});

describe("scoreFromCloses", () => {
  it("returns zero score on empty input", () => {
    const r = scoreFromCloses([]);
    expect(r.score).toBe(0);
    expect(r.breakdown.winRate).toBe(0);
  });

  it("positive returns + high win rate → positive score", () => {
    const closes = [
      { pnl: 100, marginAtOpen: 500 },
      { pnl: 80, marginAtOpen: 500 },
      { pnl: -20, marginAtOpen: 500 },
      { pnl: 50, marginAtOpen: 500 },
    ];
    const r = scoreFromCloses(closes);
    expect(r.score).toBeGreaterThan(0);
    expect(r.breakdown.winRate).toBeCloseTo(0.75);
    expect(r.breakdown.avgReturn).toBeGreaterThan(0);
  });

  it("losses + low win rate → negative score", () => {
    const closes = [
      { pnl: -100, marginAtOpen: 500 },
      { pnl: -80, marginAtOpen: 500 },
      { pnl: 20, marginAtOpen: 500 },
      { pnl: -50, marginAtOpen: 500 },
    ];
    const r = scoreFromCloses(closes);
    expect(r.score).toBeLessThan(0);
    expect(r.breakdown.winRate).toBeCloseTo(0.25);
  });
});

describe("recordClose + classification", () => {
  it("stays B until min closes are recorded", () => {
    let s = initClassifierState();
    s = recordClose(s, "Alice", { pnl: 100, marginAtOpen: 500 });
    s = recordClose(s, "Alice", { pnl: 100, marginAtOpen: 500 });
    // Only 2 closes; min is 3 → still B
    expect(getUserClass(s, "Alice")).toBe("B");
  });

  it("flips to A once enough profitable closes accumulate", () => {
    let s = initClassifierState();
    for (let i = 0; i < 5; i++) {
      s = recordClose(s, "Alice", { pnl: 100, marginAtOpen: 500 });
    }
    expect(getUserClass(s, "Alice")).toBe("A");
    expect(getUserScore(s, "Alice")).toBeGreaterThan(CLASSIFIER_A_THRESHOLD);
  });

  it("stays B for a losing trader past min closes", () => {
    let s = initClassifierState();
    for (let i = 0; i < 5; i++) {
      s = recordClose(s, "Alice", { pnl: -100, marginAtOpen: 500 });
    }
    expect(getUserClass(s, "Alice")).toBe("B");
    expect(getUserScore(s, "Alice")).toBeLessThan(0);
  });

  it("rolling window: only the last N closes matter", () => {
    let s = initClassifierState();
    // Pile up wins (would put them in A)
    for (let i = 0; i < CLASSIFIER_WINDOW; i++) {
      s = recordClose(s, "Alice", { pnl: 100, marginAtOpen: 500 });
    }
    expect(getUserClass(s, "Alice")).toBe("A");
    // Now flush the window with losses; the old wins should age out.
    for (let i = 0; i < CLASSIFIER_WINDOW; i++) {
      s = recordClose(s, "Alice", { pnl: -100, marginAtOpen: 500 });
    }
    expect(getUserClass(s, "Alice")).toBe("B");
  });

  it("getUserStats exposes breakdown for UI", () => {
    let s = initClassifierState();
    for (let i = 0; i < 4; i++) {
      s = recordClose(s, "Alice", { pnl: 50, marginAtOpen: 500 });
    }
    const stats = getUserStats(s, "Alice");
    expect(stats.closes).toBe(4);
    expect(stats.breakdown.winRate).toBeCloseTo(1);
    expect(stats.currentClass).toBe("A");
    expect(stats.reasonText).toMatch(/peer-matched/);
  });

  it("isolates users — Alice's classification doesn't affect Bob", () => {
    let s = initClassifierState();
    for (let i = 0; i < 5; i++) {
      s = recordClose(s, "Alice", { pnl: 100, marginAtOpen: 500 });
    }
    expect(getUserClass(s, "Alice")).toBe("A");
    expect(getUserClass(s, "Bob")).toBe("B"); // never classified
  });
});

describe("routeFor", () => {
  function aliceScored(state, n, pnlPerClose) {
    let s = state;
    for (let i = 0; i < n; i++) {
      s = recordClose(s, "Alice", { pnl: pnlPerClose, marginAtOpen: 500 });
    }
    return s;
  }

  it("routes A-classified users to A", () => {
    const s = aliceScored(initClassifierState(), 5, 100);
    expect(getUserClass(s, "Alice")).toBe("A");
    expect(routeFor({ state: s, userId: "Alice", positionMargin: 500 })).toBe("A");
  });

  it("routes B-classified users to B", () => {
    const s = aliceScored(initClassifierState(), 5, -100);
    expect(routeFor({ state: s, userId: "Alice", positionMargin: 500 })).toBe("B");
  });

  it("whale exception: oversized position force-classed to A", () => {
    // Set Alice up as B-class with avg margin 500
    const s = aliceScored(initClassifierState(), 5, -100);
    expect(getUserClass(s, "Alice")).toBe("B");
    // Big bet — 3x average, above WHALE_MARGIN_MULT
    expect(
      routeFor({
        state: s,
        userId: "Alice",
        positionMargin: 500 * (WHALE_MARGIN_MULT + 0.5),
      })
    ).toBe("A");
  });

  it("normal-sized B-class bet stays B", () => {
    const s = aliceScored(initClassifierState(), 5, -100);
    expect(routeFor({ state: s, userId: "Alice", positionMargin: 500 })).toBe("B");
  });
});

describe("transparency invariants", () => {
  it("reasonText explains why a user is B-class with a specific gap", () => {
    let s = initClassifierState();
    for (let i = 0; i < 5; i++) {
      s = recordClose(s, "Alice", { pnl: -50, marginAtOpen: 500 });
    }
    const stats = getUserStats(s, "Alice");
    expect(stats.currentClass).toBe("B");
    expect(stats.reasonText).toMatch(/need \+/);
  });

  it("reasonText for unknown user references the min closes", () => {
    const stats = getUserStats(initClassifierState(), "Bob");
    expect(stats.reasonText).toMatch(new RegExp(`${CLASSIFIER_MIN_CLOSES}`));
  });
});
