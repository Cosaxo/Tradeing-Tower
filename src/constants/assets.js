// ESMA leverage caps per EU Regulation 2018/796 + MiFID II derivatives
// - Single stocks:           5:1   3(e)
// - Minor indices:          10:1   3(b)
// - Commodities (non-gold): 10:1   3(d)
// - Major indices & gold:   20:1   3(a)
// - Major FX:               30:1   3(a)
// - Minor FX:               20:1   3(b)
// - Crypto:                  2:1   ESMA35-43-869
// - Volatility products:     2:1   (MiFID II art.57)
// - Managed futures ETF:     5:1   (UCITS art.51)
// - Structured products:     2:1   (PRIIPs KID max leverage equivalent)

export const ASSET_CLASSES = {
  CRYPTO: { label: "Crypto", esmaMaxLev: 2, color: "#818cf8", ref: "ESMA35-43-869" },
  FX_MAJOR: { label: "FX Major", esmaMaxLev: 30, color: "#34d399", ref: "3(a)" },
  FX_MINOR: { label: "FX Minor", esmaMaxLev: 20, color: "#2dd4bf", ref: "3(b)" },
  INDEX_MAJOR: { label: "Major Index", esmaMaxLev: 20, color: "#fbbf24", ref: "3(a)" },
  INDEX_MINOR: { label: "Minor Index", esmaMaxLev: 10, color: "#f97316", ref: "3(b)" },
  STOCK: { label: "Single Stock", esmaMaxLev: 5, color: "#e879f9", ref: "3(e)" },
  COMMODITY: { label: "Commodity", esmaMaxLev: 10, color: "#a78bfa", ref: "3(d)" },
  GOLD: { label: "Gold", esmaMaxLev: 20, color: "#eab308", ref: "3(a)" },
  VOLATILITY: { label: "Volatility", esmaMaxLev: 2, color: "#f43f5e", ref: "MiFID II art.57" },
  MANAGED_FUT: { label: "Managed Futures", esmaMaxLev: 5, color: "#06b6d4", ref: "UCITS art.51" },
  STRUCTURED: { label: "Structured", esmaMaxLev: 2, color: "#8b5cf6", ref: "PRIIPs KID" },
};

export const PAIRS = {
  // CRYPTO 2:1
  "BTC-PERP": { symbol: "BTC", name: "Bitcoin", assetClass: "CRYPTO", mu: 0.0001, sigma: 0.022, startPrice: 67000, color: "#f59e0b", flag: "", hedgeChar: -0.1 },
  "ETH-PERP": { symbol: "ETH", name: "Ethereum", assetClass: "CRYPTO", mu: 0.0002, sigma: 0.026, startPrice: 3200, color: "#818cf8", flag: "", hedgeChar: -0.1 },
  "SOL-PERP": { symbol: "SOL", name: "Solana", assetClass: "CRYPTO", mu: 0.0003, sigma: 0.038, startPrice: 178, color: "#34d399", flag: "", hedgeChar: -0.1 },

  // FX MAJOR 30:1
  EURUSD: { symbol: "EUR/USD", name: "Euro / US Dollar", assetClass: "FX_MAJOR", mu: 0.000005, sigma: 0.004, startPrice: 1.0845, color: "#34d399", flag: "", hedgeChar: 0.0 },
  GBPUSD: { symbol: "GBP/USD", name: "Cable", assetClass: "FX_MAJOR", mu: 0.000003, sigma: 0.005, startPrice: 1.271, color: "#60a5fa", flag: "", hedgeChar: 0.0 },
  USDJPY: { symbol: "USD/JPY", name: "Dollar Yen", assetClass: "FX_MAJOR", mu: 0.000008, sigma: 0.0045, startPrice: 154.2, color: "#f87171", flag: "", hedgeChar: 0.2 },

  // FX MINOR 20:1
  EURNOK: { symbol: "EUR/NOK", name: "Euro / Krone", assetClass: "FX_MINOR", mu: 0.000002, sigma: 0.007, startPrice: 11.72, color: "#2dd4bf", flag: "kr", hedgeChar: -0.2 },
  EURSEK: { symbol: "EUR/SEK", name: "Euro / Krona", assetClass: "FX_MINOR", mu: 0.000001, sigma: 0.006, startPrice: 11.38, color: "#38bdf8", flag: "kr", hedgeChar: -0.1 },

  // MAJOR INDICES 20:1
  SPX500: { symbol: "SPX", name: "S&P 500", assetClass: "INDEX_MAJOR", mu: 0.00015, sigma: 0.009, startPrice: 5240, color: "#fbbf24", flag: "", hedgeChar: -0.3 },
  DAX40: { symbol: "DAX", name: "DAX 40", assetClass: "INDEX_MAJOR", mu: 0.00012, sigma: 0.01, startPrice: 18350, color: "#fb923c", flag: "", hedgeChar: -0.3 },
  FTSE100: { symbol: "FTSE", name: "FTSE 100", assetClass: "INDEX_MAJOR", mu: 0.00008, sigma: 0.008, startPrice: 8240, color: "#a78bfa", flag: "", hedgeChar: -0.3 },
  NAS100: { symbol: "NDX", name: "Nasdaq 100", assetClass: "INDEX_MAJOR", mu: 0.00018, sigma: 0.012, startPrice: 18200, color: "#67e8f9", flag: "", hedgeChar: -0.35 },

  // MINOR INDICES 10:1
  OBX25: { symbol: "OBX", name: "Oslo Brs OBX", assetClass: "INDEX_MINOR", mu: 0.0001, sigma: 0.012, startPrice: 1385, color: "#f97316", flag: "", hedgeChar: -0.25 },
  OMXS30: { symbol: "OMXS", name: "OMX Stockholm 30", assetClass: "INDEX_MINOR", mu: 0.00009, sigma: 0.011, startPrice: 2580, color: "#e879f9", flag: "", hedgeChar: -0.25 },

  // SINGLE STOCKS 5:1
  AAPL: { symbol: "AAPL", name: "Apple Inc.", assetClass: "STOCK", mu: 0.00012, sigma: 0.015, startPrice: 189.5, color: "#c084fc", flag: "", hedgeChar: -0.2 },
  MSFT: { symbol: "MSFT", name: "Microsoft Corp.", assetClass: "STOCK", mu: 0.00014, sigma: 0.013, startPrice: 415.2, color: "#60a5fa", flag: "", hedgeChar: -0.2 },
  NVDA: { symbol: "NVDA", name: "NVIDIA Corp.", assetClass: "STOCK", mu: 0.00022, sigma: 0.028, startPrice: 875.4, color: "#4ade80", flag: "", hedgeChar: -0.25 },
  TSLA: { symbol: "TSLA", name: "Tesla Inc.", assetClass: "STOCK", mu: 0.00008, sigma: 0.035, startPrice: 172.8, color: "#f43f5e", flag: "", hedgeChar: -0.2 },
  META: { symbol: "META", name: "Meta Platforms", assetClass: "STOCK", mu: 0.00016, sigma: 0.02, startPrice: 512.6, color: "#3b82f6", flag: "", hedgeChar: -0.2 },
  EQNR: { symbol: "EQNR", name: "Equinor ASA", assetClass: "STOCK", mu: 0.00006, sigma: 0.016, startPrice: 28.4, color: "#fb923c", flag: "", hedgeChar: -0.15 },
  NEL: { symbol: "NEL", name: "Nel ASA", assetClass: "STOCK", mu: 0.00003, sigma: 0.042, startPrice: 0.78, color: "#34d399", flag: "", hedgeChar: -0.1 },

  // COMMODITIES 10:1
  BRENT: { symbol: "BRENT", name: "Brent Crude", assetClass: "COMMODITY", mu: 0.00005, sigma: 0.016, startPrice: 82.4, color: "#a78bfa", flag: "", hedgeChar: 0.1 },
  NATGAS: { symbol: "NGAS", name: "Natural Gas", assetClass: "COMMODITY", mu: 0.00002, sigma: 0.03, startPrice: 2.14, color: "#67e8f9", flag: "", hedgeChar: 0.0 },
  WHEAT: { symbol: "WHEAT", name: "Wheat", assetClass: "COMMODITY", mu: 0.00003, sigma: 0.018, startPrice: 548, color: "#d4a96a", flag: "", hedgeChar: 0.1 },
  COPPER: { symbol: "COPPER", name: "Copper", assetClass: "COMMODITY", mu: 0.00008, sigma: 0.014, startPrice: 4.48, color: "#fb923c", flag: "", hedgeChar: -0.1 },

  // GOLD 20:1
  GOLD: { symbol: "GOLD", name: "Gold Spot", assetClass: "GOLD", mu: 0.00006, sigma: 0.008, startPrice: 2340, color: "#eab308", flag: "Au", hedgeChar: 0.6 },

  // VOLATILITY PRODUCTS 2:1
  VIX: {
    symbol: "VIX",
    name: "CBOE Volatility Index",
    assetClass: "VOLATILITY",
    mu: -0.001,
    sigma: 0.06,
    startPrice: 18.5,
    color: "#f43f5e",
    flag: "",
    description: "Fear gauge. Rises when equities crash. Core black swan hedge.",
    hedgeChar: 0.9,
    meanReverts: true,
    meanLevel: 20,
  },
  VSTOXX: {
    symbol: "VSTOXX",
    name: "Euro Stoxx 50 Volatility",
    assetClass: "VOLATILITY",
    mu: -0.0008,
    sigma: 0.055,
    startPrice: 17.2,
    color: "#fb7185",
    flag: "",
    description: "European VIX equivalent.",
    hedgeChar: 0.85,
    meanReverts: true,
    meanLevel: 19,
  },

  // MANAGED FUTURES 5:1
  DBMF: {
    symbol: "DBMF",
    name: "iMGP DBi Managed Futures",
    assetClass: "MANAGED_FUT",
    mu: 0.00008,
    sigma: 0.012,
    startPrice: 28.4,
    color: "#06b6d4",
    flag: "",
    description: "Liquid alt CTA ETF. Trend-follows across 6 asset classes.",
    hedgeChar: 0.5,
  },
  KMLM: {
    symbol: "KMLM",
    name: "KFA Mount Lucas Mgd Fut",
    assetClass: "MANAGED_FUT",
    mu: 0.00006,
    sigma: 0.014,
    startPrice: 34.1,
    color: "#0ea5e9",
    flag: "",
    description: "Rules-based managed futures. Low equity beta.",
    hedgeChar: 0.45,
  },

  // STRUCTURED / TAIL RISK 2:1
  TAIL: {
    symbol: "TAIL",
    name: "Cambria Tail Risk ETF",
    assetClass: "STRUCTURED",
    mu: -0.0003,
    sigma: 0.02,
    startPrice: 18.6,
    color: "#8b5cf6",
    flag: "",
    description: "Systematic put-spread portfolio. Pays off in crashes.",
    hedgeChar: 0.95,
  },
  BTAL: {
    symbol: "BTAL",
    name: "AGFiQ Anti-Beta ETF",
    assetClass: "STRUCTURED",
    mu: -0.0001,
    sigma: 0.016,
    startPrice: 19.8,
    color: "#a78bfa",
    flag: "",
    description: "Long low-beta / short high-beta.",
    hedgeChar: 0.75,
  },
};

export const ACTIVE_PAIRS = [
  "BTC-PERP",
  "ETH-PERP",
  "SOL-PERP",
  "SPX500",
  "DAX40",
  "NAS100",
  "EURUSD",
  "EURNOK",
  "AAPL",
  "NVDA",
  "EQNR",
  "GOLD",
  "BRENT",
  "OBX25",
  "VIX",
  "VSTOXX",
  "DBMF",
  "TAIL",
];
