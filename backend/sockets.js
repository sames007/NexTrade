const axios = require("axios");

const connections = new Map();
const streams = new Map();
const MAX_ALERTS_PER_CONNECTION = 20;
const MAX_SUBSCRIPTIONS_PER_CONNECTION = 12;
const MAX_TARGET_PRICE = 1_000_000_000;
const POLL_INTERVAL_MS = Math.max(Number(process.env.LIVE_POLL_INTERVAL_MS) || 30000, 15000);
const requestConfig = {
  proxy: false,
  timeout: 12000,
  headers: {
    accept: "application/json",
    "user-agent": "NexTrade/1.0"
  }
};

const cryptoSymbols = new Map([
  ["BTC", "bitcoin"],
  ["ETH", "ethereum"],
  ["SOL", "solana"],
  ["XRP", "ripple"],
  ["ADA", "cardano"],
  ["DOGE", "dogecoin"]
]);

function normalizeStockSymbol(value) {
  const symbol = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.-]/g, "")
    .slice(0, 12);

  return /^[A-Z0-9.-]{1,12}$/.test(symbol) ? symbol : "";
}

function normalizeCryptoId(value) {
  const id = String(value || "").trim().toLowerCase();
  return /^[a-z0-9-]{2,80}$/.test(id) ? id : "";
}

function getSubscription(data = {}) {
  if (data.assetType === "crypto") {
    const symbol = String(data.symbol || "").trim().toUpperCase().slice(0, 12);
    const id = normalizeCryptoId(data.id) || cryptoSymbols.get(symbol);

    if (!id) return null;

    return {
      assetType: "crypto",
      id,
      key: `crypto:${id}`,
      symbol: symbol || id.toUpperCase()
    };
  }

  const symbol = normalizeStockSymbol(data.symbol);
  if (!symbol) return null;

  return {
    assetType: "stock",
    key: `stock:${symbol}`,
    symbol
  };
}

async function getStockQuote(subscription) {
  const response = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(subscription.symbol)}`,
    {
      ...requestConfig,
      params: { range: "1d", interval: "1m" }
    }
  );
  const meta = response.data?.chart?.result?.[0]?.meta || {};
  const price = Number(meta.regularMarketPrice);
  const previousClose = Number(meta.chartPreviousClose || meta.previousClose);

  if (!Number.isFinite(price)) {
    throw new Error("Stock quote has no price");
  }

  const change = Number.isFinite(previousClose) && previousClose > 0
    ? ((price - previousClose) / previousClose) * 100
    : 0;

  return {
    ...subscription,
    price,
    change: Number(change.toFixed(2)),
    source: "Yahoo Finance",
    timestamp: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : new Date().toISOString()
  };
}

async function getCryptoQuote(subscription) {
  const response = await axios.get("https://api.coingecko.com/api/v3/simple/price", {
    ...requestConfig,
    params: {
      ids: subscription.id,
      vs_currencies: "usd",
      include_24hr_change: true
    }
  });
  const coin = response.data?.[subscription.id] || {};
  const price = Number(coin.usd);

  if (!Number.isFinite(price)) {
    throw new Error("Crypto quote has no price");
  }

  return {
    ...subscription,
    price,
    change: Number(Number(coin.usd_24h_change || 0).toFixed(2)),
    source: "CoinGecko",
    timestamp: new Date().toISOString()
  };
}

async function publishLatestPrice(io, subscription) {
  try {
    const quote =
      subscription.assetType === "crypto"
        ? await getCryptoQuote(subscription)
        : await getStockQuote(subscription);

    io.to(subscription.key).emit("price-update", quote);
    checkAlerts(subscription.key, quote);
  } catch (error) {
    io.to(subscription.key).emit("stream-status", {
      ...subscription,
      status: "unavailable",
      message: "Live quote provider is temporarily unavailable."
    });
  }
}

function stopStreamIfEmpty(io, key) {
  const room = io.sockets.adapter.rooms.get(key);
  if (room && room.size > 0) return;

  const stream = streams.get(key);
  if (stream) {
    clearInterval(stream.interval);
    streams.delete(key);
  }
}

function startStream(io, subscription) {
  if (streams.has(subscription.key)) return;

  void publishLatestPrice(io, subscription);

  const interval = setInterval(() => {
    void publishLatestPrice(io, subscription);
    stopStreamIfEmpty(io, subscription.key);
  }, POLL_INTERVAL_MS);

  streams.set(subscription.key, { interval, subscription });
}

function checkAlerts(key, quote) {
  for (const connection of connections.values()) {
    connection.alerts.forEach((alert) => {
      if (alert.key !== key || alert.triggered) return;

      const hitAbove = alert.type === "above" && quote.price >= alert.target;
      const hitBelow = alert.type === "below" && quote.price <= alert.target;
      if (!hitAbove && !hitBelow) return;

      alert.triggered = true;
      connection.socket.emit("alert-triggered", {
        ...quote,
        target: alert.target,
        type: alert.type,
        message: `${quote.symbol} reached $${quote.price}`,
        triggeredAt: new Date().toISOString()
      });
    });
  }
}

function setupSockets(io) {
  io.on("connection", (socket) => {
    connections.set(socket.id, {
      socket,
      subscriptions: new Map(),
      alerts: []
    });

    socket.on("subscribe", (data = {}) => {
      const subscription = getSubscription(data);
      const connection = connections.get(socket.id);

      if (!subscription || !connection) {
        socket.emit("stream-status", { status: "error", message: "Invalid market symbol." });
        return;
      }

      if (
        !connection.subscriptions.has(subscription.key) &&
        connection.subscriptions.size >= MAX_SUBSCRIPTIONS_PER_CONNECTION
      ) {
        socket.emit("stream-status", { status: "error", message: "Subscription limit reached." });
        return;
      }

      socket.join(subscription.key);
      connection.subscriptions.set(subscription.key, subscription);
      startStream(io, subscription);

      socket.emit("subscribed", {
        ...subscription,
        message: `Subscribed to ${subscription.symbol}`
      });
    });

    socket.on("unsubscribe", (data = {}) => {
      const subscription = getSubscription(data);
      const connection = connections.get(socket.id);
      if (!subscription || !connection) return;

      socket.leave(subscription.key);
      connection.subscriptions.delete(subscription.key);
      setTimeout(() => stopStreamIfEmpty(io, subscription.key), 100);
    });

    socket.on("set-alert", (data = {}) => {
      const subscription = getSubscription(data);
      const connection = connections.get(socket.id);
      const target = Number(data.target);

      if (
        !subscription ||
        !connection ||
        !Number.isFinite(target) ||
        target <= 0 ||
        target > MAX_TARGET_PRICE
      ) {
        socket.emit("alert-error", { message: "Valid symbol and target price are required." });
        return;
      }

      const alert = {
        id: `${socket.id}-${Date.now()}`,
        key: subscription.key,
        assetType: subscription.assetType,
        id: subscription.id,
        symbol: subscription.symbol,
        target,
        type: data.type === "below" ? "below" : "above",
        triggered: false
      };

      connection.alerts.push(alert);
      if (connection.alerts.length > MAX_ALERTS_PER_CONNECTION) {
        connection.alerts.splice(0, connection.alerts.length - MAX_ALERTS_PER_CONNECTION);
      }

      socket.join(subscription.key);
      connection.subscriptions.set(subscription.key, subscription);
      startStream(io, subscription);
      socket.emit("alert-set", { alert });
    });

    socket.on("cancel-alert", (data = {}) => {
      const connection = connections.get(socket.id);
      if (!connection) return;

      connection.alerts = connection.alerts.filter((alert) => alert.id !== data.alertId);
      socket.emit("alert-cancelled", { alertId: data.alertId });
    });

    socket.on("disconnect", () => {
      const connection = connections.get(socket.id);
      if (connection) {
        for (const key of connection.subscriptions.keys()) {
          setTimeout(() => stopStreamIfEmpty(io, key), 100);
        }
      }

      connections.delete(socket.id);
    });
  });
}

module.exports = setupSockets;
