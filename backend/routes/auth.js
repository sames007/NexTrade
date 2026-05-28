const express = require("express");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const router = express.Router();
const users = new Map();
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;
const SESSION_COOKIE = "market_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const JWT_ISSUER = "nextrade";
const JWT_AUDIENCE = "nextrade-web";
const AUTH_WINDOW_MS = 15 * 60 * 1000;
const AUTH_MAX_ATTEMPTS = 12;
const authAttempts = new Map();

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function cleanName(name = "") {
  return String(name).trim().replace(/\s+/g, " ").slice(0, 80) || "Market User";
}

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;

  if (secret && secret.length >= 24) {
    return secret;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET must be set to at least 24 characters.");
  }

  return "development-only-change-this-secret";
}

if (process.env.NODE_ENV === "production") {
  getJwtSecret();
}

function authRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || "unknown";
  const existing = authAttempts.get(key);
  const bucket =
    existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + AUTH_WINDOW_MS };

  bucket.count += 1;
  authAttempts.set(key, bucket);

  if (bucket.count > AUTH_MAX_ATTEMPTS) {
    res.setHeader("Retry-After", String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: "Too many login attempts. Try again later." });
  }

  if (authAttempts.size > 10000) {
    for (const [bucketKey, value] of authAttempts) {
      if (value.resetAt <= now) authAttempts.delete(bucketKey);
    }
  }

  return next();
}

function issueToken(user) {
  return jwt.sign(
    {
      email: user.email,
      name: user.name
    },
    getJwtSecret(),
    {
      audience: JWT_AUDIENCE,
      expiresIn: SESSION_MAX_AGE_SECONDS,
      issuer: JWT_ISSUER,
      subject: user.email
    }
  );
}

function serializeSessionCookie(value, maxAge = SESSION_MAX_AGE_SECONDS) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict; Priority=High${secure}`;
}

function setSessionCookie(res, user) {
  res.setHeader("Set-Cookie", serializeSessionCookie(issueToken(user)));
}

function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", serializeSessionCookie("", 0));
}

function readCookie(req, name) {
  const cookies = String(req.headers.cookie || "").split(";");

  for (const cookie of cookies) {
    const [cookieName, ...parts] = cookie.trim().split("=");
    if (cookieName === name) {
      try {
        return decodeURIComponent(parts.join("="));
      } catch (error) {
        return "";
      }
    }
  }

  return "";
}

function readSessionToken(req) {
  const header = req.headers.authorization || "";
  const [scheme, bearerToken] = header.split(" ");

  if (scheme === "Bearer" && bearerToken) {
    return bearerToken;
  }

  return readCookie(req, SESSION_COOKIE);
}

function decodeSession(req) {
  const token = readSessionToken(req);
  if (!token) return null;

  const user = jwt.verify(token, getJwtSecret(), {
    audience: JWT_AUDIENCE,
    issuer: JWT_ISSUER
  });

  const email = normalizeEmail(user.email);
  if (!EMAIL_PATTERN.test(email)) return null;

  return {
    email,
    name: cleanName(user.name)
  };
}

router.post("/register", authRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const name = cleanName(body.name);

    if (!EMAIL_PATTERN.test(email)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({
        error: `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`
      });
    }

    if (users.has(email)) {
      return res.status(409).json({ error: "An account already exists." });
    }

    const user = {
      email,
      name,
      password: await bcrypt.hash(password, 12),
      createdAt: new Date().toISOString()
    };

    users.set(email, user);
    setSessionCookie(res, user);

    return res.status(201).json({
      message: "Registration successful",
      user: { email: user.email, name: user.name }
    });
  } catch (error) {
    console.error("Register error:", error.message);
    return res.status(500).json({ error: "Registration is unavailable right now." });
  }
});

router.post("/login", authRateLimit, async (req, res) => {
  try {
    const body = req.body || {};
    const email = normalizeEmail(body.email);
    const password = String(body.password || "");
    const user = users.get(email);

    if (!EMAIL_PATTERN.test(email) || !password || password.length > MAX_PASSWORD_LENGTH) {
      return res.status(400).json({ error: "Email and password are required." });
    }

    const passwordMatch = user ? await bcrypt.compare(password, user.password) : false;
    if (!user || !passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    setSessionCookie(res, user);
    return res.json({
      message: "Login successful",
      user: { email: user.email, name: user.name }
    });
  } catch (error) {
    console.error("Login error:", error.message);
    return res.status(500).json({ error: "Login is unavailable right now." });
  }
});

router.post("/logout", (req, res) => {
  clearSessionCookie(res);
  res.json({ message: "Logged out." });
});

function requireSession(req, res, next) {
  try {
    const user = decodeSession(req);

    if (!user) {
      return res.status(401).json({ error: "Authentication required." });
    }

    req.user = user;
    return next();
  } catch (error) {
    clearSessionCookie(res);
    return res.status(401).json({ error: "Invalid or expired session." });
  }
}

function optionalSession(req, res, next) {
  try {
    req.user = decodeSession(req);
  } catch (error) {
    clearSessionCookie(res);
    req.user = null;
  }

  next();
}

router.get("/verify", requireSession, (req, res) => {
  res.json({ valid: true, user: req.user });
});

module.exports = { optionalSession, router };
