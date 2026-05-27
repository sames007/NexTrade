# NexTrade

NexTrade is a full-stack market intelligence dashboard for provider-sourced
stocks, crypto, financial news, watchlists, real-time quote updates, alerts,
and AI-generated plain-English explanations.

This application is for information and education only. It is not financial
advice, and its historical next-session estimate is not an investment recommendation.

## Live Demo

NexTrade is deployed on Render: [https://nextrade-jgp0.onrender.com/](https://nextrade-jgp0.onrender.com/)

## Features

- Dashboard with live-provider market cards, headlines, movers, and an AI summary.
- Stock search by ticker or company name, OHLC chart views, and informational next-session estimates.
- Crypto market list and detail/history views with provider attribution.
- News category/topic search, full-article links, saved articles, and AI summaries.
- AI assistant for questions, comparisons, summaries, and chart explanations.
- Socket.IO polling streams for provider-sourced stock/crypto quotes and price alerts.
- Watchlists for stocks, crypto, and news.
- Optional local account flow using HttpOnly session cookies.

Market prices and headlines are never synthesized as live results. When a live
provider does not respond, the UI reports that data is unavailable. AI routes
may return a clearly labeled educational fallback response if Gemini is
unavailable.

## Stack And Data Providers

- Backend: Node.js, Express, Socket.IO
- Frontend: Next.js, React, Tailwind CSS, Recharts
- AI: Google Gemini API, default stable model `gemini-3.5-flash`
- Stocks: Alpha Vantage daily data, with Yahoo Finance market-data fallback
- Crypto: CoinGecko, with CoinPaprika fallback
- News: NewsAPI
- Prediction helper: Python and NumPy with walk-forward model evaluation

## Structure

```text
NexTrade/
  ai/
    predict.py
    test_predict.py
  backend/
    server.js
    sockets.js
    routes/
      ai.js
      auth.js
      crypto.js
      news.js
      stock.js
      watchlist.js
  frontend/
    app/globals.css
    components/MarketAssistantApp.jsx
    pages/
      _app.js
      crypto.js
      index.js
      login.js
      news.js
      stocks.js
  .env.example
  Dockerfile
  render.yaml
  package.json
  requirements.txt
```

## Requirements

- Node.js 18 or newer
- npm
- Python 3.10 or newer

## Setup

Install dependencies:

```bash
npm install
cd frontend
npm install
cd ..
pip install -r requirements.txt
```

Create local environment files:

```bash
copy .env.example .env
copy frontend\.env.local.example frontend\.env.local
```

Configure the backend `.env`:

```env
PORT=5000
NODE_ENV=development
FRONTEND_ORIGIN=http://localhost:3000
JWT_SECRET=replace_with_at_least_24_characters
ALPHA_VANTAGE_API_KEY=
NEWS_API_KEY=
COINGECKO_API_KEY=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.5-flash
PYTHON_BIN=python
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX=600
LIVE_POLL_INTERVAL_MS=30000
```

`FRONTEND_ORIGIN` accepts comma-separated permitted origins. Set
`TRUST_PROXY=1` only if the deployed server is behind exactly one trusted
reverse proxy.

Configure the frontend `frontend/.env.local`:

```env
NEXT_PUBLIC_API_URL=http://localhost:5000
NEXT_PUBLIC_SOCKET_URL=http://localhost:5000
```

## Run

Run both services:

```bash
npm run all
```

For a local production-style single URL, build the exported frontend and let
the backend serve it:

```bash
npm run build
npm start
```

Or run development services separately:

```bash
npm start
npm run frontend
```

- Frontend: `http://localhost:3000`
- Backend health check: `http://localhost:5000/api/health`
- Single-URL production-style build: `http://localhost:5000`

## Scripts

```bash
npm run check
npm run lint
npm run build
npm run audit
```

## REST API

```text
GET    /api/health
GET    /api/news/headlines/:country
GET    /api/news?q=market
GET    /api/stock/search/:query
GET    /api/stock/:symbol
GET    /api/stock/:symbol/predict
GET    /api/crypto/top
GET    /api/crypto/search/:query
GET    /api/crypto/:id
GET    /api/crypto/:id/history
POST   /api/ai/explain
POST   /api/ai/summarize-news
POST   /api/ai/market-insight
GET    /api/watchlist
POST   /api/watchlist/add
DELETE /api/watchlist/remove
POST   /api/auth/register
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/verify
```

## Real-Time Events

The browser subscribes through Socket.IO with either
`{ assetType: "stock", symbol: "AAPL" }` or
`{ assetType: "crypto", id: "bitcoin", symbol: "BTC" }`.

- `price-update`: provider quote including `source`, `price`, and change.
- `stream-status`: provider or subscription availability information.
- `set-alert`: creates a client-session alert for a subscribed provider quote.
- `alert-triggered`: emitted when a provider quote crosses the configured target.

## Provider Behavior

- Stocks first request Alpha Vantage data and may use Yahoo Finance when the primary provider cannot answer.
- Socket stock quotes use Yahoo Finance and identify that source in every emitted update.
- Crypto requests prefer CoinGecko. Configure a server-side Demo API key with `COINGECKO_API_KEY` for improved primary-provider reliability; CoinPaprika is used as an attributed secondary provider and successful data is retained through brief outages.
- NewsAPI is required for displayed live headlines; missing/failed provider access returns no fabricated articles.
- Gemini errors return a labeled educational fallback so the UI remains usable without misrepresenting it as Gemini output.

## Prediction Method

- The `/api/stock/:symbol/predict` estimate uses up to 100 provider-sourced daily OHLCV observations and targets the next trading-session close.
- When available, the estimate is anchored to a current Yahoo Finance quote so it aligns with the live quote stream while identifying its history source separately.
- The Python helper compares a last-price baseline with recent weighted drift and 10/20-session log-trend candidates using sequential walk-forward evaluation.
- Trend candidates receive weight only when they improve on the baseline historically; the baseline remains present to limit overreaction to noisy data.
- The response includes an estimated volatility range, historical mean absolute error compared with the baseline, validation count, and a `limited` reliability label.
- Historical and back-tested results do not predict future returns. Do not use this estimate alone to make investment decisions.

## Free Portfolio Deployment

The simplest free public demo for this codebase is one
[Render Web Service](https://render.com/docs/free) using the included
`Dockerfile` and `render.yaml`. Render supports
[Docker deploys](https://render.com/docs/docker) and
[WebSockets](https://render.com/docs/websocket), so this preserves Socket.IO
and the Python forecast helper in one service and produces a public
`https://<service-name>.onrender.com` URL.

1. Create a GitHub repository named `nextrade` and push this project without either `.env` file.
2. Revoke any API key previously exposed in chat or source, then create replacement keys.
3. Sign in to Render, choose **New > Blueprint**, connect the GitHub repository, and select `render.yaml`.
4. Keep the service on the free instance type. If `nextrade` is unavailable as a subdomain, accept Render's generated service name.
5. Enter fresh values when Render prompts for `ALPHA_VANTAGE_API_KEY`, `NEWS_API_KEY`, `COINGECKO_API_KEY`, and `GEMINI_API_KEY`.
6. After deployment, open `https://<your-render-url>/api/health`, then test Dashboard, News, Stocks prediction, Crypto, AI, and live quote updates.
7. Put the public home-page URL on your resume and GitHub README only after those checks pass.

Render free web services may sleep when idle and need a short cold start on the
first visit. This is fine for a portfolio demo, but mention that in the
repository if an interviewer may open it live.

The Docker build intentionally excludes local `.env` files. Do not add
`NEXT_PUBLIC_API_URL` or `NEXT_PUBLIC_SOCKET_URL` on Render for this single-URL
deployment; the exported browser app connects back to its own Render service.
If you later use a custom domain, add that full origin to `FRONTEND_ORIGIN`.

Suggested resume entry:

```text
NexTrade | Next.js, Node.js, Socket.IO, Python, Gemini, Alpha Vantage, CoinGecko, CoinPaprika, NewsAPI
Built and deployed a real-time market intelligence dashboard with provider-sourced
stock/crypto tracking, live alerts, AI news explanations, secure cookie sessions,
and walk-forward evaluated next-session stock estimates.
Live Demo: https://nextrade-jgp0.onrender.com/ | GitHub: https://github.com/sames007/NexTrade
```

## Security And Production Notes

- Keep `.env` and `frontend/.env.local` private; both are ignored by git.
- Rotate any API key that has been posted in chat, logs, screenshots, or a repository.
- Sessions use an HttpOnly, `SameSite=Strict` cookie; production also marks it `Secure`.
- Authentication endpoints have a dedicated brute-force rate limit in addition to the API limiter.
- CORS allows only configured origins, request bodies are size-limited, and baseline security headers are set.
- Watchlists are scoped to a signed-in session or a signed HttpOnly per-browser guest cookie.
- Users and watchlists are still memory-backed. Add a database and persistent session storage before deployment.
- On a free sleeping service, in-memory accounts and watchlists reset after restarts or spin-down; present them as demo features only.
- Add HTTPS, durable rate limiting, structured audit logging, monitoring, and an approved market-data licensing plan before production use.
