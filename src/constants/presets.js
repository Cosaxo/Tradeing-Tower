export const PRESETS = [
  {
    label: "Conservative",
    config: {
      strategy: "FIXED_LONG",
      leverage: 2.0,
      minYield: 0.0,
      tip_tiers: [{ lev_start: 1.0, lev_end: 2.0, tip: 0.015, fill_direction: "bottom-up" }],
    },
  },
  {
    label: "Aggressive",
    config: {
      strategy: "FIXED_LONG",
      leverage: 10,
      minYield: 0.0,
      tip_tiers: [{ lev_start: 4.0, lev_end: 8.0, tip: 0.12, fill_direction: "top-down" }],
    },
  },
  {
    label: "Bear Hedge",
    config: {
      strategy: "FIXED_SHORT",
      leverage: 5.0,
      side: "SHORT",
      minYield: 0.5,
      tip_tiers: [{ lev_start: 1.0, lev_end: 3.0, tip: 0.04, fill_direction: "bottom-up" }],
    },
  },
  {
    label: "Yield Farm",
    config: {
      strategy: "YIELD_CHASER",
      leverage: 8.0,
      minYield: 0.8,
      tip_tiers: [{ lev_start: 1.0, lev_end: 4.0, tip: 0.025, fill_direction: "bottom-up" }],
    },
  },
];
