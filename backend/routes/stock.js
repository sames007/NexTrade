const express = require("express");
const axios = require("axios");
const { execFile } = require("child_process");
const path = require("path");

const router = express.Router();
const stockCache = new Map();
const stockInflight = new Map();
const stockMetadataCache = new Map();
const CACHE_TTL_MS = 20 * 60 * 1000;
let lastRequestTime = 0;
const THROTTLE_DELAY_MS = 1500;
const PYTHON_BIN = process.env.PYTHON_BIN || "python";
const yahooRequestConfig = {
  proxy: false,
  timeout: 15000,
  headers: {
    accept: "application/json",
    "user-agent": "NexTrade/1.0"
  }
};

const fallbackStocks = {
  AAPL: { name: "Apple Inc." },
  AMD: { name: "Advanced Micro Devices Inc." },
  MSFT: { name: "Microsoft Corporation" },
  NVDA: { name: "NVIDIA Corporation" },
  TSLA: { name: "Tesla Inc." },
  AMZN: { name: "Amazon.com Inc." },
  GOOGL: { name: "Alphabet Inc." },
  META: { name: "Meta Platforms Inc." },
  NFLX: { name: "Netflix Inc." },
  DIS: { name: "The Walt Disney Company" },
  WMT: { name: "Walmart Inc." },
  JPM: { name: "JPMorgan Chase & Co." },
  BAC: { name: "Bank of America Corporation" },
  V: { name: "Visa Inc." },
  MA: { name: "Mastercard Incorporated" },
  IBM: { name: "International Business Machines Corporation" },
  ORCL: { name: "Oracle Corporation" },
  INTC: { name: "Intel Corporation" }
};

function validateSymbol(symbol) {
  return /^[A-Z0-9.]{1,8}$/.test(symbol);
}

function cacheGet(key) {
  const cached = stockCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function cacheSet(key, data) {
  stockCache.set(key, { data, timestamp: Date.now() });
}

function cleanSearchQuery(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9 .-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 50);
}

function normalizeSearchSymbol(value) {
  const symbol = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);

  return validateSymbol(symbol) ? symbol : "";
}

function toSearchResult(match) {
  const symbol = normalizeSearchSymbol(match["1. symbol"] || match.symbol);
  if (!symbol) return null;

  return {
    symbol,
    name: String(match["2. name"] || match.name || fallbackStocks[symbol]?.name || symbol).trim(),
    type: match["3. type"] || match.type || "Equity",
    region: match["4. region"] || match.region || "",
    marketOpen: match["5. marketOpen"] || "",
    marketClose: match["6. marketClose"] || "",
    timezone: match["7. timezone"] || "",
    currency: match["8. currency"] || match.currency || "USD",
    matchScore: Number.parseFloat(match["9. matchScore"] || match.matchScore || 0)
  };
}

function rememberStockMetadata(results = []) {
  results.forEach((result) => {
    if (result?.symbol) {
      stockMetadataCache.set(result.symbol, {
        name: result.name,
        region: result.region,
        currency: result.currency,
        type: result.type
      });
    }
  });
}

function getStockMetadata(symbol) {
  return stockMetadataCache.get(symbol) || fallbackStocks[symbol] || {};
}

function sanitizeProviderMessage(message) {
  const text = String(message || "");

  if (/rate limit|standard API call frequency|premium/i.test(text)) {
    return "Alpha Vantage rate limit reached; showing alternate market data.";
  }

  if (/api key|apikey|invalid/i.test(text)) {
    return "Alpha Vantage rejected the configured API key; showing alternate market data.";
  }

  if (/did not return price data/i.test(text)) {
    return "Alpha Vantage did not return price data; showing alternate market data.";
  }

  return text ? "Primary stock provider is unavailable; showing alternate market data when available." : "";
}

async function alphaVantageGet(params) {
  const wait = THROTTLE_DELAY_MS - (Date.now() - lastRequestTime);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  lastRequestTime = Date.now();
  return axios.get("https://www.alphavantage.co/query", {
    proxy: false,
    timeout: 15000,
    params: {
      ...params,
      apikey: process.env.ALPHA_VANTAGE_API_KEY
    }
  });
}

async function yahooGet(pathname, params = {}) {
  return axios.get(`https://query1.finance.yahoo.com${pathname}`, {
    ...yahooRequestConfig,
    params
  });
}

function unavailableStockResponse(symbol, message) {
  return {
    symbol,
    name: fallbackStocks[symbol]?.name || symbol,
    region: "",
    currency: "USD",
    type: "Equity",
    data: [],
    totalPoints: 0,
    latestPrice: null,
    dailyChange: null,
    dailyChangePercent: null,
    status: "unavailable",
    isRealData: false,
    source: "Unavailable",
    attribution: "Live stock data unavailable",
    message
  };
}

function formatSeries(symbol, timeSeries, status = "success", name = "", options = {}) {
  const data = Object.keys(timeSeries)
    .map((date) => ({
      date,
      open: Number.parseFloat(timeSeries[date]["1. open"]),
      high: Number.parseFloat(timeSeries[date]["2. high"]),
      low: Number.parseFloat(timeSeries[date]["3. low"]),
      close: Number.parseFloat(timeSeries[date]["4. close"]),
      volume: Number.parseInt(timeSeries[date]["5. volume"], 10)
    }))
    .filter((point) => Number.isFinite(point.close))
    .reverse();

  return buildStockResponse(symbol, data, status, name, options);
}

function buildStockResponse(symbol, data, status = "success", name = "", options = {}) {
  const metadata = {
    ...getStockMetadata(symbol),
    ...(options.metadata || {})
  };
  const latest = data[data.length - 1] || null;
  const previous = data[data.length - 2] || latest;
  const quotePrice = Number(options.quote?.price);
  const quotePreviousClose = Number(options.quote?.previousClose);
  const latestPrice = Number.isFinite(quotePrice) ? quotePrice : latest?.close || null;
  const previousPrice = Number.isFinite(quotePreviousClose) ? quotePreviousClose : previous?.close || latestPrice;
  const dailyChange = latestPrice && previousPrice ? latestPrice - previousPrice : 0;
  const dailyChangePercent = previousPrice ? (dailyChange / previousPrice) * 100 : 0;
  const source = options.source || "Alpha Vantage";

  return {
    symbol,
    name: name || metadata.name || symbol,
    region: metadata.region || "",
    currency: metadata.currency || "USD",
    type: metadata.type || "Equity",
    data,
    totalPoints: data.length,
    latestPrice,
    dailyChange: Number(dailyChange.toFixed(2)),
    dailyChangePercent: Number(dailyChangePercent.toFixed(2)),
    status,
    isRealData: status === "success",
    source: status === "success" ? source : "Offline fallback",
    attribution: status === "success" ? `Stock data provided by ${source}` : "Offline fallback stock data"
  };
}

async function yahooSearch(query) {
  const response = await yahooGet("/v1/finance/search", {
    q: query,
    quotesCount: 12,
    newsCount: 0
  });

  const results = (response.data?.quotes || [])
    .map((quote) =>
      toSearchResult({
        symbol: quote.symbol,
        name: quote.longname || quote.shortname || quote.symbol,
        type: quote.quoteType || "Equity",
        region: quote.exchDisp || quote.exchange || "",
        currency: quote.currency || "USD",
        matchScore: quote.score || 0
      })
    )
    .filter(Boolean)
    .filter((result) => ["equity", "etf"].includes(result.type.toLowerCase()))
    .slice(0, 10);

  rememberStockMetadata(results);
  return results;
}

async function fetchYahooStock(symbol) {
  const response = await yahooGet(`/v8/finance/chart/${encodeURIComponent(symbol)}`, {
    range: "3mo",
    interval: "1d"
  });
  const result = response.data?.chart?.result?.[0];
  const timestamps = result?.timestamp || [];
  const quote = result?.indicators?.quote?.[0] || {};
  const meta = result?.meta || {};

  const data = timestamps
    .map((timestamp, index) => ({
      date: new Date(timestamp * 1000).toISOString().split("T")[0],
      open: Number(quote.open?.[index]),
      high: Number(quote.high?.[index]),
      low: Number(quote.low?.[index]),
      close: Number(quote.close?.[index]),
      volume: Number(quote.volume?.[index] || 0)
    }))
    .filter((point) => Number.isFinite(point.close));

  if (data.length < 5) {
    throw new Error("Yahoo Finance did not return enough chart data");
  }

  const metadata = {
    name: meta.longName || meta.shortName || getStockMetadata(symbol).name || symbol,
    region: meta.exchangeName || meta.fullExchangeName || getStockMetadata(symbol).region || "",
    currency: meta.currency || getStockMetadata(symbol).currency || "USD",
    type: meta.instrumentType || getStockMetadata(symbol).type || "Equity"
  };

  stockMetadataCache.set(symbol, metadata);

  return buildStockResponse(symbol, data, "success", metadata.name, {
    metadata,
    quote: {
      price: meta.regularMarketPrice,
      previousClose: meta.chartPreviousClose || meta.previousClose
    },
    source: "Yahoo Finance"
  });
}

async function fetchStockFresh(symbol) {
  if (!process.env.ALPHA_VANTAGE_API_KEY) {
    try {
      return await fetchYahooStock(symbol);
    } catch (error) {
      return unavailableStockResponse(symbol, "No live stock data provider responded.");
    }
  }

  try {
    const response = await alphaVantageGet({
      function: "TIME_SERIES_DAILY",
      symbol,
      outputsize: "compact"
    });

    const timeSeries = response.data?.["Time Series (Daily)"];
    if (!timeSeries) {
      const providerMessage =
        response.data?.Note ||
        response.data?.Information ||
        response.data?.["Error Message"] ||
        "Alpha Vantage did not return price data";

      try {
        const result = await fetchYahooStock(symbol);
        result.message = sanitizeProviderMessage(providerMessage);
        return result;
      } catch (error) {
        return unavailableStockResponse(symbol, sanitizeProviderMessage(providerMessage));
      }
    }

    const result = formatSeries(symbol, timeSeries);
    return result;
  } catch (err) {
    try {
      const result = await fetchYahooStock(symbol);
      result.message = "Alpha Vantage is unavailable; showing Yahoo Finance market data.";
      return result;
    } catch (error) {
      return unavailableStockResponse(symbol, "Stock data providers are unavailable.");
    }
  }
}

async function fetchStock(symbol) {
  const cached = cacheGet(symbol);
  if (cached) return cached;

  if (stockInflight.has(symbol)) {
    return stockInflight.get(symbol);
  }

  const request = fetchStockFresh(symbol).then((result) => {
    cacheSet(symbol, result);
    return result;
  });

  stockInflight.set(symbol, request);

  try {
    return await request;
  } finally {
    stockInflight.delete(symbol);
  }
}

router.get("/search/:query", async (req, res) => {
  const query = cleanSearchQuery(req.params.query);

  if (query.length < 1 || query.length > 50) {
    return res.status(400).json({ error: "Invalid search query" });
  }

  const cacheKey = `search:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  const fallbackMatches = Object.entries(fallbackStocks)
    .filter(([symbol, stock]) => symbol.includes(query) || stock.name.toUpperCase().includes(query))
    .map(([symbol, stock]) =>
      toSearchResult({
        symbol,
        name: stock.name,
        region: "United States",
        currency: "USD",
        type: "Equity",
        matchScore: symbol === query ? 1 : 0.75
      })
    );

  if (!process.env.ALPHA_VANTAGE_API_KEY) {
    let results = fallbackMatches;
    let status = "catalog";
    let attribution = "Local symbol catalog";

    try {
      const yahooResults = await yahooSearch(query);
      if (yahooResults.length) {
        results = yahooResults;
        status = "success";
        attribution = "Stock search provided by Yahoo Finance";
      }
    } catch (error) {
      rememberStockMetadata(fallbackMatches);
    }

    rememberStockMetadata(results);
    const result = { status, results, attribution };
    cacheSet(cacheKey, result);
    return res.json(result);
  }

  try {
    const response = await alphaVantageGet({
      function: "SYMBOL_SEARCH",
      keywords: query
    });

    let apiResults = (response.data?.bestMatches || [])
      .map(toSearchResult)
      .filter(Boolean)
      .filter((result) => result.type.toLowerCase().includes("equity") || result.currency)
      .slice(0, 10);
    let attribution = "Stock search provided by Alpha Vantage";

    if (!apiResults.length) {
      try {
        apiResults = await yahooSearch(query);
        attribution = "Stock search provided by Yahoo Finance";
      } catch (error) {
        apiResults = [];
      }
    }

    const results = apiResults.length ? apiResults : fallbackMatches;

    rememberStockMetadata(results);

    const result = {
      status: apiResults.length ? "success" : fallbackMatches.length ? "catalog" : "empty",
      results,
      attribution
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    let results = fallbackMatches;
    let status = fallbackMatches.length ? "catalog" : "empty";
    let attribution = "Local symbol catalog";

    try {
      const yahooResults = await yahooSearch(query);
      if (yahooResults.length) {
        results = yahooResults;
        status = "success";
        attribution = "Stock search provided by Yahoo Finance";
      }
    } catch (error) {
      rememberStockMetadata(fallbackMatches);
    }

    rememberStockMetadata(results);
    const result = { status, results, attribution };
    cacheSet(cacheKey, result);
    return res.json(result);
  }
});

router.get("/:symbol", async (req, res) => {
  const symbol = normalizeSearchSymbol(req.params.symbol);
  if (!validateSymbol(symbol)) {
    return res.status(400).json({ error: "Invalid stock symbol format" });
  }

  const result = await fetchStock(symbol);
  return res.json(result);
});

router.get("/:symbol/predict", async (req, res) => {
  const symbol = normalizeSearchSymbol(req.params.symbol);
  if (!validateSymbol(symbol)) {
    return res.status(400).json({ error: "Invalid stock symbol format" });
  }

  const stock = await fetchStock(symbol);
  let anchorStock = stock;

  if (stock.source !== "Yahoo Finance") {
    try {
      anchorStock = await fetchYahooStock(symbol);
    } catch (error) {
      anchorStock = stock;
    }
  }

  const history = (stock.data || [])
    .slice(-100)
    .filter((point) => Number.isFinite(point.close) && point.close > 0)
    .map((point) => ({
      date: point.date,
      open: Number(point.open),
      high: Number(point.high),
      low: Number(point.low),
      close: Number(point.close),
      volume: Number(point.volume)
    }));

  if (history.length < 20) {
    return res.status(503).json({
      error: "At least 20 live daily observations are required for a responsible estimate."
    });
  }

  const pythonScript = path.join(__dirname, "../../ai/predict.py");
  const quotedPrice = Number(anchorStock.latestPrice);
  const currentPrice =
    Number.isFinite(quotedPrice) && quotedPrice > 0
      ? quotedPrice
      : history[history.length - 1].close;

  function baselineForecast() {
    const returns = history.slice(1).map((point, index) =>
      Math.log(point.close / history[index].close)
    );
    const average = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance =
      returns.reduce((sum, value) => sum + (value - average) ** 2, 0) /
      Math.max(returns.length - 1, 1);
    const volatility = Math.max(Math.sqrt(variance), 0.0025);
    const rangeWidth = Math.min(0.35, 1.645 * volatility);

    return {
      predictedPrice: currentPrice,
      estimatedLow: currentPrice * Math.exp(-rangeWidth),
      estimatedHigh: currentPrice * Math.exp(rangeWidth),
      predictedChangePercent: 0,
      volatilityPercent: volatility * 100,
      direction: "uncertain",
      reliability: "limited",
      method: "Last-price baseline (forecast helper unavailable)",
      horizon: "Next trading session close",
      validationPoints: 0,
      backtestMaePercent: null,
      baselineMaePercent: null,
      directionAccuracyPercent: null,
      modelMetrics: []
    };
  }

  function sendPrediction(forecast, status = "baseline") {
    const prediction = Number(forecast.predictedPrice);
    const estimatedLow = Number(forecast.estimatedLow);
    const estimatedHigh = Number(forecast.estimatedHigh);
    const numberOrNull = (value, digits) =>
      value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value))
        ? Number(Number(value).toFixed(digits))
        : null;

    if (!Number.isFinite(prediction) || prediction <= 0) {
      return sendPrediction(baselineForecast(), "baseline");
    }

    const priceChange = prediction - currentPrice;
    const percentChange = currentPrice ? (priceChange / currentPrice) * 100 : 0;

    return res.json({
      symbol,
      currentPrice,
      predictedPrice: Number(prediction.toFixed(2)),
      estimatedLow: Number.isFinite(estimatedLow) ? Number(estimatedLow.toFixed(2)) : null,
      estimatedHigh: Number.isFinite(estimatedHigh) ? Number(estimatedHigh.toFixed(2)) : null,
      priceChange: Number(priceChange.toFixed(2)),
      percentChange: Number(percentChange.toFixed(2)),
      direction: forecast.direction || "uncertain",
      reliability: forecast.reliability || "limited",
      method: forecast.method || "Last-price baseline",
      horizon: forecast.horizon || "Next trading session close",
      historySource: stock.source,
      currentPriceSource: anchorStock.source,
      volatilityPercent: numberOrNull(forecast.volatilityPercent, 2),
      validationPoints: Number(forecast.validationPoints) || 0,
      backtestMaePercent: numberOrNull(forecast.backtestMaePercent, 2),
      baselineMaePercent: numberOrNull(forecast.baselineMaePercent, 2),
      directionAccuracyPercent: numberOrNull(forecast.directionAccuracyPercent, 1),
      modelMetrics: Array.isArray(forecast.modelMetrics) ? forecast.modelMetrics : [],
      dataPoints: history.length,
      status,
      disclaimer:
        "One-session estimate from historical data only. Past and back-tested performance do not predict future results; this is not financial advice."
    });
  }

  try {
    execFile(
      PYTHON_BIN,
      [pythonScript, JSON.stringify({ history, currentPrice })],
      { maxBuffer: 1024 * 1024, timeout: 10000 },
      (err, stdout) => {
        let forecast;
        try {
          forecast = JSON.parse(String(stdout || "").trim());
        } catch (error) {
          forecast = null;
        }

        if (err || !forecast) {
          return sendPrediction(baselineForecast());
        }

        return sendPrediction(forecast, "success");
      }
    );
  } catch (error) {
    return sendPrediction(baselineForecast());
  }
});

module.exports = router;
