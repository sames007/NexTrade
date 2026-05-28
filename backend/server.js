const express = require("express");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const cors = require("cors");
require("dotenv").config();

const setupSockets = require("./sockets");
const { optionalSession, router: authRoutes } = require("./routes/auth");
const stockRoutes = require("./routes/stock");
const newsRoutes = require("./routes/news");
const aiRoutes = require("./routes/ai");
const cryptoRoutes = require("./routes/crypto");
const watchlistRoutes = require("./routes/watchlist");

const app = express();
const server = http.createServer(app);
const DEFAULT_FRONTEND_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5000",
  "http://127.0.0.1:5000"
];

function normalizeOrigin(origin) {
  try {
    return new URL(origin).origin;
  } catch (error) {
    return "";
  }
}

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.FRONTEND_ORIGIN || "")
    .split(",")
    .map((origin) => normalizeOrigin(origin.trim()))
    .filter(Boolean);
  const origins = new Set(configuredOrigins);
  const renderOrigin = normalizeOrigin(process.env.RENDER_EXTERNAL_URL || "");
  if (renderOrigin) {
    origins.add(renderOrigin);
  }

  if (process.env.NODE_ENV !== "production") {
    DEFAULT_FRONTEND_ORIGINS.forEach((origin) => origins.add(origin));
  }

  return origins;
}

const allowedOrigins = getAllowedOrigins();

function websocketOrigin(origin) {
  try {
    const url = new URL(origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.origin;
  } catch (error) {
    return "";
  }
}

function buildContentSecurityPolicy() {
  const connectSources = new Set(["'self'", "ws:", "wss:"]);
  allowedOrigins.forEach((origin) => {
    connectSources.add(origin);
    const socketOrigin = websocketOrigin(origin);
    if (socketOrigin) connectSources.add(socketOrigin);
  });

  const directives = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "img-src 'self' data: https:",
    "font-src 'self' data:",
    `connect-src ${Array.from(connectSources).join(" ")}`,
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'"
  ];

  if (process.env.NODE_ENV === "production") {
    directives.push("upgrade-insecure-requests");
  }

  return directives.join("; ");
}

const contentSecurityPolicy = buildContentSecurityPolicy();

const corsOptions = {
  origin(origin, callback) {
    const requestOrigin = normalizeOrigin(origin || "");
    if (!origin || allowedOrigins.has(requestOrigin)) {
      return callback(null, true);
    }

    return callback(new Error("Origin is not allowed by CORS"));
  },
  methods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

const io = new Server(server, {
  cors: corsOptions
});

const rateBuckets = new Map();
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 15 * 60 * 1000;
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 600;

function rateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const existing = rateBuckets.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : {
          count: 0,
          resetAt: now + RATE_LIMIT_WINDOW_MS
        };

  bucket.count += 1;
  rateBuckets.set(key, bucket);

  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader("Retry-After", String(retryAfter));
    return res.status(429).json({ error: "Too many requests. Please slow down and try again soon." });
  }

  if (rateBuckets.size > 10000) {
    for (const [bucketKey, value] of rateBuckets) {
      if (value.resetAt <= now) rateBuckets.delete(bucketKey);
    }
  }

  return next();
}

if (process.env.TRUST_PROXY) {
  const trustProxy = /^\d+$/.test(process.env.TRUST_PROXY)
    ? Number(process.env.TRUST_PROXY)
    : process.env.TRUST_PROXY === "true";
  app.set("trust proxy", trustProxy);
}
app.disable("x-powered-by");
app.use((req, res, next) => {
  res.setHeader("Content-Security-Policy", contentSecurityPolicy);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("X-Permitted-Cross-Domain-Policies", "none");
  if (process.env.NODE_ENV === "production") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
  next();
});

app.use(cors(corsOptions));
app.use(rateLimit);
app.use(express.json({ limit: "100kb" }));

app.use("/api/auth", authRoutes);
app.use("/api/stock", stockRoutes);
app.use("/api/news", newsRoutes);
app.use("/api/ai", aiRoutes);
app.use("/api/crypto", cryptoRoutes);
app.use("/api/watchlist", optionalSession, watchlistRoutes);

setupSockets(io);

function sendServiceStatus(req, res) {
  res.json({
    status: "ok",
    name: "NexTrade",
    timestamp: new Date().toISOString()
  });
}

const frontendOutputPath = path.join(__dirname, "../frontend/out");
const frontendIndexPath = path.join(frontendOutputPath, "index.html");

app.get("/api/health", sendServiceStatus);

if (fs.existsSync(frontendIndexPath)) {
  app.use(express.static(frontendOutputPath));
  app.get("/", (req, res) => res.sendFile(frontendIndexPath));
} else {
  app.get("/", sendServiceStatus);
}

const PORT = process.env.PORT || 5000;

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err.message === "Origin is not allowed by CORS") {
    return res.status(403).json({ error: "Origin is not allowed." });
  }

  console.error("Unhandled server error:", err.message);
  return res.status(500).json({ error: "Server error" });
});

function startServer(port = PORT) {
  return server.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log("Socket.IO ready");
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, server, io, startServer };
