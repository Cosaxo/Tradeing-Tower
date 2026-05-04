// Global insurance system state — replaces the per-pair `insurancePool`
// from the pre-Phase-5 architecture.
//
// This object is persisted at the App level (parallel to floatsState) so
// every pair can refer to it without each carrying a duplicate slice.
//
// Shape:
//   {
//     markets: [...],          // one per event from STANDARD_EVENTS
//     reinsurance: [...],      // 3 parallel products
//     allocations: { byUser: { ... } },
//   }

import { STANDARD_EVENTS } from "../lib/insuranceEvents.js";
import { makeInsuranceMarket } from "../lib/insuranceMarket.js";
import { makeReinsuranceSet } from "../lib/reinsurance.js";
import { initAllocationsState } from "../lib/allocations.js";

export function initInsuranceState() {
  return {
    markets: STANDARD_EVENTS.map((ev) =>
      makeInsuranceMarket({
        eventId: ev.id,
        pairKey: ev.pairKey ?? null,
        category: ev.category,
      })
    ),
    reinsurance: makeReinsuranceSet(),
    allocations: initAllocationsState(),
  };
}

// Resolve the market record for an event id (e.g. for UI display next
// to the event label).
export function findMarketByEventId(insuranceState, eventId) {
  return insuranceState?.markets?.find((m) => m.eventId === eventId) ?? null;
}
