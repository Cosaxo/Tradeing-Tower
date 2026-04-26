import { describe, it, expect } from "vitest";
import {
  publishLegOffer,
  placeRentalBid,
  matchRentalAuction,
  settleRentals,
  terminateRental,
  DEFAULT_MIN_TIP_RATE,
  RENTAL_MARGIN_FRACTION,
  OFFER_TTL_EPOCHS,
  BID_TTL_EPOCHS,
} from "../rentalMarket.js";

// ---------------------------------------------------------------------------
// publish / place
// ---------------------------------------------------------------------------

describe("publishLegOffer", () => {
  it("returns a well-formed active offer with TTL", () => {
    const offer = publishLegOffer({
      pairLapId: "PLAP-1",
      legSide: "long",
      ownerId: "You",
      pairKey: "BTCUSD",
      publishedAtEpoch: 10,
    });
    expect(offer.id).toMatch(/^RENT-OFFER-/);
    expect(offer.legSide).toBe("long");
    expect(offer.ownerId).toBe("You");
    expect(offer.minTipRate).toBe(DEFAULT_MIN_TIP_RATE);
    expect(offer.expiresAtEpoch).toBe(10 + OFFER_TTL_EPOCHS);
    expect(offer.active).toBe(true);
  });
});

describe("placeRentalBid", () => {
  it("returns a well-formed bid with TTL", () => {
    const bid = placeRentalBid({
      bidderId: "NPC-Bear",
      pairKey: "BTCUSD",
      maxTipRate: 0.01,
      rentalMargin: 200,
      publishedAtEpoch: 10,
    });
    expect(bid.id).toMatch(/^RENT-BID-/);
    expect(bid.bidderId).toBe("NPC-Bear");
    expect(bid.maxTipRate).toBe(0.01);
    expect(bid.rentalMargin).toBe(200);
    expect(bid.expiresAtEpoch).toBe(10 + BID_TTL_EPOCHS);
  });
});

// ---------------------------------------------------------------------------
// matching
// ---------------------------------------------------------------------------

describe("matchRentalAuction", () => {
  const baseOffer = {
    id: "O-1",
    pairLapId: "PLAP-1",
    legSide: "long",
    ownerId: "You",
    pairKey: "BTCUSD",
    minTipRate: 0.005,
    durationEpochs: 5,
    publishedAtEpoch: 0,
    expiresAtEpoch: 100,
    active: true,
  };
  const baseBid = {
    id: "B-1",
    bidderId: "NPC-Bear",
    pairKey: "BTCUSD",
    maxTipRate: 0.008,
    durationEpochs: 5,
    rentalMargin: 200,
    publishedAtEpoch: 0,
    expiresAtEpoch: 100,
    active: true,
  };

  it("matches a single eligible bid against a single offer at the owner's floor", () => {
    const result = matchRentalAuction({
      offers: [baseOffer],
      bids: [baseBid],
      currentEpoch: 1,
    });
    expect(result.newRentals).toHaveLength(1);
    const rental = result.newRentals[0];
    // Clears at the OWNER's floor (renter pays 0.005, not their max 0.008).
    expect(rental.tipRate).toBe(0.005);
    expect(rental.ownerId).toBe("You");
    expect(rental.renterId).toBe("NPC-Bear");
    expect(rental.expiresAtEpoch).toBe(1 + 5);
    expect(rental.active).toBe(true);
    expect(result.remainingOffers).toHaveLength(0);
    expect(result.remainingBids).toHaveLength(0);
  });

  it("does not match a bid below the floor", () => {
    const lowBid = { ...baseBid, id: "B-2", maxTipRate: 0.001 };
    const result = matchRentalAuction({
      offers: [baseOffer],
      bids: [lowBid],
      currentEpoch: 1,
    });
    expect(result.newRentals).toHaveLength(0);
    expect(result.remainingOffers).toHaveLength(1);
    expect(result.remainingBids).toHaveLength(1);
  });

  it("matches highest bid first when multiple bids compete on one offer", () => {
    const highBid = { ...baseBid, id: "B-A", maxTipRate: 0.012, bidderId: "NPC-Whale" };
    const lowBid = { ...baseBid, id: "B-B", maxTipRate: 0.006, bidderId: "NPC-Bear" };
    const result = matchRentalAuction({
      offers: [baseOffer],
      bids: [lowBid, highBid],
      currentEpoch: 1,
    });
    expect(result.newRentals).toHaveLength(1);
    expect(result.newRentals[0].renterId).toBe("NPC-Whale");
    // Low bid stays in the orderbook.
    expect(result.remainingBids).toHaveLength(1);
    expect(result.remainingBids[0].id).toBe("B-B");
  });

  it("expires offers / bids past their TTL and reports them in expired arrays", () => {
    const expiredOffer = { ...baseOffer, id: "O-X", expiresAtEpoch: 5 };
    const liveOffer = { ...baseOffer, id: "O-Y" };
    const expiredBid = { ...baseBid, id: "B-X", expiresAtEpoch: 5 };
    const liveBid = { ...baseBid, id: "B-Y" };
    const result = matchRentalAuction({
      offers: [expiredOffer, liveOffer],
      bids: [expiredBid, liveBid],
      currentEpoch: 10,
    });
    expect(result.expiredOffers.map((o) => o.id)).toContain("O-X");
    expect(result.expiredBids.map((b) => b.id)).toContain("B-X");
    expect(result.newRentals).toHaveLength(1);
    expect(result.newRentals[0].id).toMatch(/^RENT-/);
  });

  it("only matches within the same pair", () => {
    const ethOffer = { ...baseOffer, id: "O-E", pairKey: "ETHUSD" };
    const btcBid = { ...baseBid, id: "B-B" }; // BTCUSD bid
    const result = matchRentalAuction({
      offers: [ethOffer],
      bids: [btcBid],
      currentEpoch: 1,
    });
    expect(result.newRentals).toHaveLength(0);
    expect(result.remainingOffers).toHaveLength(1);
    expect(result.remainingBids).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// settlement
// ---------------------------------------------------------------------------

describe("settleRentals", () => {
  const lap = { margin: 1000, leverage: 2, openPrice: 100 };
  const findPairedLap = (id) => (id === "PLAP-1" ? lap : null);

  function makeRental(overrides = {}) {
    return {
      id: "R-1",
      pairLapId: "PLAP-1",
      legSide: "long",
      ownerId: "You",
      renterId: "NPC-Bear",
      pairKey: "BTCUSD",
      tipRate: 0.005,
      durationEpochs: 5,
      rentalMargin: 200,
      accruedOwnerTips: 0,
      matchedAtEpoch: 1,
      expiresAtEpoch: 6,
      active: true,
      ...overrides,
    };
  }

  it("flat price ⇒ renter pays just the tip fee, owner accrues + flushes it", () => {
    const r = makeRental();
    const result = settleRentals({
      activeRentals: [r],
      findPairedLap,
      priceOld: 100,
      priceNew: 100,
      currentEpoch: 2,
    });
    expect(result.rentals).toHaveLength(1);
    // legNotional = 500 × 2 = 1000; tipFee = 0.005 × 1000 = 5.
    expect(result.ownerCredits.You).toBeCloseTo(5);
    // Renter margin reduced by exactly the tip fee.
    expect(result.rentals[0].rentalMargin).toBeCloseTo(200 - 5);
    // accruedOwnerTips reset to 0 after flush.
    expect(result.rentals[0].accruedOwnerTips).toBe(0);
  });

  it("price up ⇒ long-leg renter gains; pays tip fee from new margin", () => {
    const r = makeRental();
    const result = settleRentals({
      activeRentals: [r],
      findPairedLap,
      priceOld: 100,
      priceNew: 105,
      currentEpoch: 2,
    });
    // Long P&L = 500 × 2 × (e^0.0488 - 1) ≈ 50.04. tipFee = 5.
    // Renter margin = 200 + 50.04 - 5 ≈ 245.04.
    expect(result.rentals[0].rentalMargin).toBeGreaterThan(200);
    expect(result.terminated).toHaveLength(0);
  });

  it("price down enough ⇒ long-leg renter blows margin → DEFAULT", () => {
    const r = makeRental({ rentalMargin: 50 }); // small margin → easy to default
    const result = settleRentals({
      activeRentals: [r],
      findPairedLap,
      priceOld: 100,
      priceNew: 90, // ≈ -10% → loss ≈ 500 × 2 × (e^-0.105 - 1) ≈ -100
      currentEpoch: 2,
    });
    expect(result.terminated).toHaveLength(1);
    expect(result.terminated[0].reason).toBe("default");
    expect(result.defaultedRenters).toContain("NPC-Bear");
    // Owner still gets accrued tips up to the default tick.
    expect(result.ownerCredits.You).toBeGreaterThanOrEqual(0);
  });

  it("epoch >= expiresAtEpoch ⇒ EXPIRE cleanly", () => {
    const r = makeRental({ expiresAtEpoch: 2 });
    const result = settleRentals({
      activeRentals: [r],
      findPairedLap,
      priceOld: 100,
      priceNew: 100,
      currentEpoch: 2,
    });
    expect(result.terminated).toHaveLength(1);
    expect(result.terminated[0].reason).toBe("expired");
    expect(result.terminated[0].finalRenterMargin).toBeGreaterThan(0);
    expect(result.rentals).toHaveLength(0);
  });

  it("missing underlying paired LAP ⇒ terminate gracefully", () => {
    const r = makeRental({ pairLapId: "PLAP-MISSING" });
    const result = settleRentals({
      activeRentals: [r],
      findPairedLap,
      priceOld: 100,
      priceNew: 100,
      currentEpoch: 2,
    });
    expect(result.terminated).toHaveLength(1);
    expect(result.terminated[0].reason).toBe("lap-gone");
  });

  it("empty input is a no-op", () => {
    const result = settleRentals({
      activeRentals: [],
      findPairedLap,
      priceOld: 100,
      priceNew: 105,
      currentEpoch: 2,
    });
    expect(result.rentals).toEqual([]);
    expect(result.terminated).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// manual termination (e.g. owner closes paired LAP)
// ---------------------------------------------------------------------------

describe("terminateRental", () => {
  it("marks rental inactive and reports the refund / final owner credit", () => {
    const r = {
      id: "R-1",
      active: true,
      rentalMargin: 150,
      accruedOwnerTips: 8,
    };
    const result = terminateRental(r);
    expect(result.rental.active).toBe(false);
    expect(result.refundToRenter).toBe(150);
    expect(result.finalOwnerCredit).toBe(8);
  });

  it("returns null on already-inactive rentals", () => {
    expect(terminateRental({ active: false })).toBeNull();
    expect(terminateRental(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// constants sanity
// ---------------------------------------------------------------------------

describe("module constants are sensible", () => {
  it("rental margin fraction is between 0 and 1", () => {
    expect(RENTAL_MARGIN_FRACTION).toBeGreaterThan(0);
    expect(RENTAL_MARGIN_FRACTION).toBeLessThan(1);
  });
  it("default min tip rate is positive", () => {
    expect(DEFAULT_MIN_TIP_RATE).toBeGreaterThan(0);
  });
});
