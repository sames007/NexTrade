const express = require("express");
const axios = require("axios");

const router = express.Router();
const cryptoCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
let lastRequestTime = 0;
const THROTTLE_DELAY_MS = 1200;
const coinPaprikaIds = new Map([
  ["bitcoin", "btc-bitcoin"],
  ["ethereum", "eth-ethereum"],
  ["tether", "usdt-tether"],
  ["binancecoin", "bnb-binance-coin"],
  ["solana", "sol-solana"],
  ["ripple", "xrp-xrp"],
  ["usd-coin", "usdc-usd-coin"],
  ["dogecoin", "doge-dogecoin"],
  ["cardano", "ada-cardano"],
  ["tron", "trx-tron"]
]);

function cacheGet(key) {
  const cached = cryptoCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function cacheSet(key, data) {
  cryptoCache.set(key, { data, timestamp: Date.now() });
}

function cachedFallback(key) {
  const cached = cryptoCache.get(key)?.data;
  if (!cached) return null;

  return {
    ...cached,
    status: "stale",
    message: "CoinGecko is temporarily unavailable; showing the last retrieved data."
  };
}

async function coingeckoGet(path, params = {}) {
  const wait = THROTTLE_DELAY_MS - (Date.now() - lastRequestTime);
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }

  lastRequestTime = Date.now();
  const apiKey = String(process.env.COINGECKO_API_KEY || "").trim();
  return axios.get(`https://api.coingecko.com/api/v3${path}`, {
    proxy: false,
    timeout: 15000,
    params,
    headers: {
      accept: "application/json",
      "user-agent": "NexTrade/1.0",
      ...(apiKey ? { "x-cg-demo-api-key": apiKey } : {})
    }
  });
}

function coinPaprikaId(value) {
  return coinPaprikaIds.get(value) || value;
}

async function coinPaprikaGet(path, params = {}) {
  return axios.get(`https://api.coinpaprika.com/v1${path}`, {
    proxy: false,
    timeout: 15000,
    params,
    headers: {
      accept: "application/json",
      "user-agent": "NexTrade/1.0"
    }
  });
}

function toMarketCoin(coin) {
  return {
    id: coin.id,
    symbol: String(coin.symbol || "").toUpperCase(),
    name: coin.name || "Unknown",
    image: coin.image || "",
    currentPrice: Number(coin.current_price || coin.currentPrice || 0),
    marketCap: coin.market_cap || coin.marketCap || null,
    marketCapRank: coin.market_cap_rank || coin.marketCapRank || null,
    priceChange24h: Number(coin.price_change_24h || 0),
    priceChangePercent24h: Number(coin.price_change_percentage_24h || coin.priceChangePercent24h || 0),
    volume24h: Number(coin.total_volume || coin.volume24h || 0)
  };
}

function toCoinPaprikaMarketCoin(coin) {
  const quote = coin.quotes?.USD || {};

  return {
    id: coin.id,
    symbol: String(coin.symbol || "").toUpperCase(),
    name: coin.name || "Unknown",
    image: "",
    currentPrice: Number(quote.price || 0),
    marketCap: quote.market_cap || null,
    marketCapRank: coin.rank || null,
    priceChange24h: null,
    priceChangePercent24h: Number(quote.percent_change_24h || 0),
    volume24h: Number(quote.volume_24h || 0)
  };
}

function normalizeCryptoId(value) {
  const cryptoId = String(value || "").trim().toLowerCase();
  return /^[a-z0-9-]{2,80}$/.test(cryptoId) ? cryptoId : "";
}

function normalizeSearchQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 .-]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 80);
}

router.get("/top", async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const cacheKey = `top:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await coingeckoGet("/coins/markets", {
      vs_currency: "usd",
      order: "market_cap_desc",
      per_page: limit,
      page: 1,
      sparkline: false,
      price_change_percentage: "24h"
    });

    const result = {
      status: "success",
      isRealData: true,
      data: response.data.map(toMarketCoin),
      count: response.data.length,
      timestamp: new Date().toISOString(),
      attribution: "Data provided by CoinGecko"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    try {
      const response = await coinPaprikaGet("/tickers", {
        quotes: "USD",
        limit
      });
      const data = response.data.slice(0, limit).map(toCoinPaprikaMarketCoin);
      const result = {
        status: "success",
        isRealData: true,
        data,
        count: data.length,
        timestamp: new Date().toISOString(),
        attribution: "Data provided by CoinPaprika"
      };

      cacheSet(cacheKey, result);
      return res.json(result);
    } catch (alternateError) {
      const fallback = cachedFallback(cacheKey);
      if (fallback) return res.json(fallback);
    }

    return res.json({
      status: "unavailable",
      isRealData: false,
      data: [],
      count: 0,
      message: "Live crypto data is unavailable right now.",
      timestamp: new Date().toISOString(),
      attribution: "CoinGecko unavailable"
    });
  }
});

router.get("/search/:query", async (req, res) => {
  const query = normalizeSearchQuery(req.params.query);
  if (!query) return res.status(400).json({ error: "Search query is required" });

  const cacheKey = `search:${query}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await coingeckoGet("/search", { query });
    const results = (response.data.coins || []).slice(0, 12).map((coin) => ({
      id: coin.id,
      name: coin.name,
      symbol: String(coin.symbol || "").toUpperCase(),
      image: coin.large || coin.thumb || ""
    }));

    const result = {
      status: "success",
      isRealData: true,
      query,
      results,
      count: results.length,
      attribution: "Data provided by CoinGecko"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    const fallback = cachedFallback(cacheKey);
    if (fallback) return res.json(fallback);

    return res.json({
      status: "unavailable",
      isRealData: false,
      query,
      results: [],
      count: 0,
      message: "Live crypto search is unavailable right now.",
      attribution: "CoinGecko unavailable"
    });
  }
});

router.get("/:id/history", async (req, res) => {
  const cryptoId = normalizeCryptoId(req.params.id);
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);

  if (!cryptoId) {
    return res.status(400).json({ error: "Invalid crypto ID" });
  }

  const cacheKey = `history:${cryptoId}:${days}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await coingeckoGet(`/coins/${cryptoId}/market_chart`, {
      vs_currency: "usd",
      days
    });

    const prices = (response.data.prices || []).map(([timestamp, price]) => ({
      time: new Date(timestamp).toISOString(),
      price: Number(price.toFixed(6))
    }));

    const volumes = (response.data.total_volumes || []).map(([timestamp, volume]) => ({
      time: new Date(timestamp).toISOString(),
      volume: Number(volume.toFixed(2))
    }));

    const result = {
      status: "success",
      isRealData: true,
      id: cryptoId,
      prices,
      volumes,
      attribution: "Data provided by CoinGecko"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    try {
      const paprikaId = coinPaprikaId(cryptoId);
      const start = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
      const response = await coinPaprikaGet(`/tickers/${encodeURIComponent(paprikaId)}/historical`, {
        start,
        interval: "1d",
        quote: "usd"
      });
      const prices = response.data.map((point) => ({
        time: point.timestamp,
        price: Number(Number(point.price).toFixed(6))
      }));
      const volumes = response.data.map((point) => ({
        time: point.timestamp,
        volume: Number(Number(point.volume_24h || 0).toFixed(2))
      }));
      const result = {
        status: "success",
        isRealData: true,
        id: cryptoId,
        prices,
        volumes,
        attribution: "Data provided by CoinPaprika"
      };

      cacheSet(cacheKey, result);
      return res.json(result);
    } catch (alternateError) {
      const fallback = cachedFallback(cacheKey);
      if (fallback) return res.json(fallback);
    }

    return res.json({
      status: "unavailable",
      isRealData: false,
      id: cryptoId,
      prices: [],
      volumes: [],
      message: "Live crypto history is unavailable right now.",
      attribution: "CoinGecko unavailable"
    });
  }
});

router.get("/:id", async (req, res) => {
  const cryptoId = normalizeCryptoId(req.params.id);
  if (!cryptoId) return res.status(400).json({ error: "Invalid crypto ID" });

  const cacheKey = `detail:${cryptoId}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const response = await coingeckoGet(`/coins/${cryptoId}`, {
      localization: false,
      tickers: false,
      market_data: true,
      community_data: false,
      developer_data: false,
      sparkline: false
    });

    const coin = response.data;
    const result = {
      status: "success",
      isRealData: true,
      id: coin.id,
      symbol: String(coin.symbol || "").toUpperCase(),
      name: coin.name || "Unknown",
      image: coin.image?.large || "",
      description: coin.description?.en || "",
      currentPrice: Number(coin.market_data?.current_price?.usd || 0),
      marketCap: coin.market_data?.market_cap?.usd || null,
      marketCapRank: coin.market_cap_rank || null,
      priceChangePercent24h: Number(coin.market_data?.price_change_percentage_24h || 0),
      volume24h: Number(coin.market_data?.total_volume?.usd || 0),
      circulatingSupply: coin.market_data?.circulating_supply || null,
      attribution: "Data provided by CoinGecko"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    try {
      const response = await coinPaprikaGet(`/tickers/${encodeURIComponent(coinPaprikaId(cryptoId))}`, {
        quotes: "USD"
      });
      const ticker = response.data;
      const quote = ticker.quotes?.USD || {};
      const result = {
        status: "success",
        isRealData: true,
        id: cryptoId,
        symbol: String(ticker.symbol || "").toUpperCase(),
        name: ticker.name || "Unknown",
        image: "",
        description: "",
        currentPrice: Number(quote.price || 0),
        marketCap: quote.market_cap || null,
        marketCapRank: ticker.rank || null,
        priceChangePercent24h: Number(quote.percent_change_24h || 0),
        volume24h: Number(quote.volume_24h || 0),
        circulatingSupply: ticker.circulating_supply || null,
        attribution: "Data provided by CoinPaprika"
      };

      cacheSet(cacheKey, result);
      return res.json(result);
    } catch (alternateError) {
      const fallback = cachedFallback(cacheKey);
      if (fallback) return res.json(fallback);
    }

    return res.status(503).json({
      status: "unavailable",
      isRealData: false,
      error: "Live crypto detail is unavailable right now.",
      attribution: "CoinGecko unavailable"
    });
  }
});

module.exports = router;
