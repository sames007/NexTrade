const express = require("express");
const axios = require("axios");

const router = express.Router();
const requestConfig = {
  proxy: false,
  timeout: 15000
};
const newsCache = new Map();
const CACHE_TTL_MS = 5 * 60 * 1000;
const allowedCategories = new Set([
  "business",
  "technology",
  "general",
  "science",
  "health",
  "sports",
  "entertainment"
]);
const allowedSearchCategories = new Set(["", "crypto", "finance", ...allowedCategories]);

function cacheGet(key) {
  const cached = newsCache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }
  return null;
}

function cacheSet(key, data) {
  newsCache.set(key, { data, timestamp: Date.now() });
}

function cleanText(value, maxLength = 500) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function toArticle(article) {
  return {
    title: cleanText(article.title || "Untitled", 240),
    description: cleanText(article.description || "No description available", 500),
    source: cleanText(article.source?.name || article.source || "Unknown", 120),
    author: cleanText(article.author || "Unknown", 120),
    url: safeUrl(article.url),
    image: safeUrl(article.urlToImage || article.image),
    publishedAt: article.publishedAt || new Date().toISOString(),
    content: article.content ? `${cleanText(article.content, 240)}...` : ""
  };
}

function respondUnavailable(res, query, reason) {
  return res.json({
    query,
    totalResults: 0,
    articles: [],
    status: "unavailable",
    message: reason,
    attribution: "Live news unavailable"
  });
}

router.get("/", async (req, res) => {
  const query = cleanText(req.query.q || "stock market", 100);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const category = cleanText(req.query.category || "", 30).toLowerCase();

  if (query.length < 2 || query.length > 100) {
    return res.status(400).json({ error: "Query must be 2-100 characters" });
  }

  if (!allowedSearchCategories.has(category)) {
    return res.status(400).json({ error: "Invalid news category" });
  }

  const cacheKey = `search:${query}:${category}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    if (!process.env.NEWS_API_KEY) {
      return respondUnavailable(res, query, "NewsAPI key is not configured.");
    }

    const finalQuery =
      category === "crypto"
        ? `${query} crypto OR bitcoin OR ethereum`
        : category === "finance"
        ? `${query} finance OR markets OR stocks`
        : query;
    const response = await axios.get("https://newsapi.org/v2/everything", {
      ...requestConfig,
      params: {
        q: finalQuery,
        sortBy: "publishedAt",
        language: "en",
        pageSize: limit,
        apiKey: process.env.NEWS_API_KEY
      }
    });

    if (response.data.status !== "ok") {
      return respondUnavailable(res, query, response.data.message || "NewsAPI returned an error.");
    }

    const articles = (response.data.articles || []).map(toArticle);
    const result = {
      query,
      totalResults: response.data.totalResults || articles.length,
      articles,
      status: articles.length ? "success" : "empty",
      attribution: "News articles provided by NewsAPI.org"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    return respondUnavailable(res, query, "Live news provider is unavailable.");
  }
});

router.get("/headlines/:country", async (req, res) => {
  const country = String(req.params.country || "us").toLowerCase();
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50);
  const category = String(req.query.category || "business").toLowerCase();

  if (!/^[a-z]{2}$/.test(country)) {
    return res.status(400).json({ error: "Invalid country code" });
  }

  if (!allowedCategories.has(category)) {
    return res.status(400).json({ error: "Invalid news category" });
  }

  const cacheKey = `headlines:${country}:${category}:${limit}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    if (!process.env.NEWS_API_KEY) {
      return respondUnavailable(res, `${country}:${category}`, "NewsAPI key is not configured.");
    }

    const response = await axios.get("https://newsapi.org/v2/top-headlines", {
      ...requestConfig,
      params: {
        country,
        category,
        pageSize: limit,
        apiKey: process.env.NEWS_API_KEY
      }
    });

    if (response.data.status !== "ok") {
      return respondUnavailable(res, `${country}:${category}`, response.data.message || "NewsAPI returned an error.");
    }

    const articles = (response.data.articles || []).map(toArticle);
    const result = {
      country,
      category,
      totalResults: response.data.totalResults || articles.length,
      articles,
      status: articles.length ? "success" : "empty",
      attribution: "Top headlines provided by NewsAPI.org"
    };

    cacheSet(cacheKey, result);
    return res.json(result);
  } catch (err) {
    return respondUnavailable(res, `${country}:${category}`, "Live headlines provider is unavailable.");
  }
});

module.exports = router;
