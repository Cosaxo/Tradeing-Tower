import { describe, it, expect } from "vitest";
import {
  createOffer,
  matchBorrowRequest,
  settleLending,
  cancelOffer,
} from "../lending.js";

describe("lending offers + matching", () => {
  it("creates offer with active flag", () => {
    const offer = createOffer("A", 1000, 0.005, 10);
    expect(offer.active).toBe(true);
    expect(offer.remaining).toBe(1000);
  });

  it("matches cheapest offer first", () => {
    const offers = [
      createOffer("A", 500, 0.01, 10),
      createOffer("B", 500, 0.005, 10),
    ];
    const { borrows, unfilled } = matchBorrowRequest(offers, "X", 300, 0.02);
    expect(borrows.length).toBe(1);
    expect(borrows[0].lenderId).toBe("B");
    expect(borrows[0].amount).toBe(300);
    expect(unfilled).toBe(0);
  });

  it("splits across multiple offers", () => {
    const offers = [
      createOffer("A", 500, 0.005, 10),
      createOffer("B", 300, 0.006, 10),
    ];
    const { borrows, unfilled } = matchBorrowRequest(offers, "X", 700, 0.02);
    expect(borrows.length).toBe(2);
    expect(borrows[0].amount + borrows[1].amount).toBe(700);
    expect(unfilled).toBe(0);
  });

  it("reports unfilled when offers insufficient", () => {
    const offers = [createOffer("A", 100, 0.005, 10)];
    const { unfilled } = matchBorrowRequest(offers, "X", 500, 0.02);
    expect(unfilled).toBe(400);
  });

  it("skips offers above maxRate", () => {
    const offers = [createOffer("A", 500, 0.01, 10)];
    const { borrows, unfilled } = matchBorrowRequest(offers, "X", 300, 0.005);
    expect(borrows.length).toBe(0);
    expect(unfilled).toBe(300);
  });
});

describe("settleLending", () => {
  it("pays rent per active borrow", () => {
    const offers = [createOffer("A", 1000, 0.005, 10)];
    const { borrows } = matchBorrowRequest(offers, "X", 500, 0.02);
    const { borrows: settled, totalRent, payouts } = settleLending(borrows, offers);
    expect(totalRent).toBeCloseTo(500 * 0.005, 6);
    expect(payouts.A).toBeCloseTo(500 * 0.005, 6);
    expect(settled[0].remaining).toBe(9);
  });

  it("deactivates borrows when duration expires", () => {
    const borrows = [{ id: "x", borrowerId: "X", lenderId: "A", amount: 100, rate: 0.01, remaining: 1, active: true }];
    const { borrows: settled } = settleLending(borrows, []);
    expect(settled[0].active).toBe(false);
  });
});

describe("cancelOffer", () => {
  it("flips active flag", () => {
    const offers = [createOffer("A", 1000, 0.005, 10)];
    const updated = cancelOffer(offers, offers[0].id);
    expect(updated[0].active).toBe(false);
  });
});
