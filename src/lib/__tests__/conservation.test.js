import { describe, it, expect } from "vitest";
import { checkConservation, formatConservationLog } from "../conservation.js";

describe("checkConservation", () => {
  it("reports ok when claims within backing + tolerance", () => {
    const r = checkConservation({
      totalIn: 100,
      totalOut: 50,
      tipsEscrowed: 10,
      totalPoolDeposit: 5000,
    });
    expect(r.ok).toBe(true);
    expect(r.violated).toBe(false);
  });

  it("flags violation when claims exceed backing", () => {
    const r = checkConservation({
      totalIn: 0,
      totalOut: 200,
      tipsEscrowed: 50,
      totalPoolDeposit: 100,
    });
    expect(r.ok).toBe(false);
    expect(r.violated).toBe(true);
  });

  it("retained is backing − claimed", () => {
    const r = checkConservation({
      totalIn: 50,
      totalOut: 20,
      tipsEscrowed: 5,
      totalPoolDeposit: 1000,
    });
    expect(r.retained).toBeCloseTo(1000 + 50 - 20 - 5);
  });
});

describe("formatConservationLog", () => {
  it("emits VIOLATED on failure", () => {
    const line = formatConservationLog("BTC-PERP", {
      violated: true,
      claimed: 150,
      backing: 100,
      retained: -50,
    });
    expect(line).toMatch(/VIOLATED/);
    expect(line).toMatch(/BTC-PERP/);
  });

  it("emits OK on success", () => {
    const line = formatConservationLog("EURUSD", {
      violated: false,
      claimed: 20,
      backing: 200,
      retained: 180,
    });
    expect(line).toMatch(/OK/);
  });
});
