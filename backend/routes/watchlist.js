const express = require("express");
const crypto = require("crypto");

const router = express.Router();
const watchlists = new Map();
const MAX_ITEMS_PER_BUCKET = 100;
const GUEST_COOKIE_NAME = "market_guest";
const GUEST_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

function getCookieSecret() {
  const secret = process.env.JWT_SECRET;

  if (secret && secret.length >= 24) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set to at least 24 characters.");
  }

  return "development-only-change-this-secret";
}

const COOKIE_SECRET = getCookieSecret();

function emptyWatchlist() {
  return {
    stocks: [],
    crypto: [],
    savedNews: [],
    createdAt: new Date().toISOString()
  };
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((cookie) => cookie.trim().split("="))
    .reduce((cookies, [key, ...parts]) => {
      if (key) {
        try {
          cookies[key] = decodeURIComponent(parts.join("="));
        } catch (error) {
          cookies[key] = "";
        }
      }
      return cookies;
    }, {});
}

function signGuestId(guestId) {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(guestId).digest("hex");
}

function validatedGuestId(value) {
  const [guestId, signature] = String(value || "").split(".");

  if (!/^[a-f0-9]{32}$/.test(guestId || "") || !/^[a-f0-9]{64}$/.test(signature || "")) {
    return "";
  }

  const expected = signGuestId(guestId);
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected)) ? guestId : "";
}

// Keep anonymous lists private to one browser instead of pooling all guests together.
function guestId(req, res) {
  const existingId = validatedGuestId(parseCookies(req)[GUEST_COOKIE_NAME]);

  if (existingId) {
    return existingId;
  }

  const id = crypto.randomBytes(16).toString("hex");
  const value = `${id}.${signGuestId(id)}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.append(
    "Set-Cookie",
    `${GUEST_COOKIE_NAME}=${value}; Path=/; Max-Age=${GUEST_COOKIE_MAX_AGE_SECONDS}; HttpOnly; SameSite=Strict; Priority=High${secure}`
  );
  return id;
}

function ownerKey(req, res) {
  return req.user?.email ? `user:${req.user.email}` : `guest:${guestId(req, res)}`;
}

function getWatchlist(req, res) {
  const key = ownerKey(req, res);
  if (!watchlists.has(key)) {
    watchlists.set(key, emptyWatchlist());
  }
  return watchlists.get(key);
}

function cleanText(value, max = 120) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : "";
  } catch (error) {
    return "";
  }
}

function getBucket(type) {
  if (type === "news") return "savedNews";
  if (type === "crypto") return "crypto";
  return "stocks";
}

router.get("/", (req, res) => {
  const watchlist = getWatchlist(req, res);

  res.json({
    owner: req.user?.email || "guest",
    watchlist,
    count: {
      stocks: watchlist.stocks.length,
      crypto: watchlist.crypto.length,
      savedNews: watchlist.savedNews.length
    }
  });
});

router.post("/add", (req, res) => {
  const body = req.body || {};
  const type = cleanText(body.type || "stock", 20);
  const symbol =
    type === "news" ? "" : cleanText(body.symbol || body.id || "", 30).toUpperCase();
  const name = cleanText(body.name || symbol, 120);
  const price = Number(body.price || 0);
  const url = safeUrl(body.url || "");

  if (!["stock", "crypto", "news"].includes(type)) {
    return res.status(400).json({ error: "Invalid watchlist type." });
  }

  if (!symbol && type !== "news") {
    return res.status(400).json({ error: "Symbol or asset ID is required." });
  }

  if (type === "news" && !url) {
    return res.status(400).json({ error: "A valid news article URL is required." });
  }

  const watchlist = getWatchlist(req, res);
  const item = {
    id: type === "news" ? url : symbol,
    symbol,
    name,
    price: Number.isFinite(price) && price >= 0 ? price : 0,
    url,
    addedAt: new Date().toISOString()
  };
  const bucket = getBucket(type);
  const exists = watchlist[bucket].some(
    (existing) => existing.id === item.id || (symbol && existing.symbol === symbol)
  );

  if (!exists) {
    watchlist[bucket].unshift(item);
    watchlist[bucket] = watchlist[bucket].slice(0, MAX_ITEMS_PER_BUCKET);
  }

  return res.status(201).json({
    message: `${name} added to watchlist`,
    item,
    watchlist
  });
});

router.delete("/remove", (req, res) => {
  const body = req.body || {};
  const type = cleanText(body.type || "stock", 20);

  if (!["stock", "crypto", "news"].includes(type)) {
    return res.status(400).json({ error: "Invalid watchlist type." });
  }

  const identifier =
    type === "news"
      ? safeUrl(body.id || body.url || "")
      : cleanText(body.symbol || body.id || "", 30).toUpperCase();

  if (!identifier) {
    return res.status(400).json({ error: "A watchlist item identifier is required." });
  }

  const bucket = getBucket(type);
  const watchlist = getWatchlist(req, res);
  watchlist[bucket] = watchlist[bucket].filter((item) =>
    type === "news"
      ? item.id !== identifier
      : item.symbol !== identifier && String(item.id).toUpperCase() !== identifier
  );

  return res.json({
    message: "Removed from watchlist",
    watchlist
  });
});

module.exports = router;
