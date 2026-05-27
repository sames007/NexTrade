'use client';

import { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import Link from 'next/link';
import { io } from 'socket.io-client';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || API_BASE || undefined;

const api = axios.create({
  baseURL: API_BASE,
  timeout: 20000,
  withCredentials: true,
});

const tabs = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'news', label: 'News' },
  { id: 'stocks', label: 'Stocks' },
  { id: 'crypto', label: 'Crypto' },
  { id: 'ai', label: 'AI Assistant' },
  { id: 'watchlist', label: 'Watchlist' },
];

const newsCategories = ['business', 'technology', 'finance', 'crypto'];
const stockNameMap = {
  apple: 'AAPL',
  aapl: 'AAPL',
  tesla: 'TSLA',
  tsla: 'TSLA',
  nvidia: 'NVDA',
  nvda: 'NVDA',
  microsoft: 'MSFT',
  msft: 'MSFT',
  amazon: 'AMZN',
  amzn: 'AMZN',
  google: 'GOOGL',
  alphabet: 'GOOGL',
  meta: 'META',
};
const cryptoNameMap = {
  bitcoin: 'bitcoin',
  btc: 'bitcoin',
  ethereum: 'ethereum',
  eth: 'ethereum',
  solana: 'solana',
  sol: 'solana',
  xrp: 'ripple',
  ripple: 'ripple',
  cardano: 'cardano',
  ada: 'cardano',
};

function formatCurrency(value, digits) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  const maximumFractionDigits =
    digits ?? (Math.abs(number) >= 1 ? 2 : 6);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits,
  }).format(number);
}

function formatPercent(value) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  return `${number >= 0 ? '+' : ''}${number.toFixed(2)}%`;
}

function formatErrorPercent(value) {
  if (value === null || value === undefined || value === '') {
    return 'N/A';
  }

  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : 'N/A';
}

function formatLargeNumber(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return 'N/A';
  }

  return new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(number);
}

function formatDate(value) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return 'Just now';
  }

  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function cleanSymbol(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, '')
    .slice(0, 8);
}

function cleanSearchInput(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function plainText(value = '') {
  return String(value).replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

function trendClass(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) {
    return 'text-stone-400';
  }

  return Number(value) >= 0 ? 'text-emerald-300' : 'text-rose-300';
}

function panelClass(extra = '') {
  return `rounded-[2rem] border border-white/10 bg-slate-950/70 p-5 shadow-2xl shadow-slate-950/30 backdrop-blur ${extra}`;
}

export default function MarketAssistantApp({ initialTab = 'dashboard' }) {
  const socketRef = useRef(null);
  const toastTimer = useRef(null);
  const stockSubscriptionRef = useRef('');
  const cryptoSubscriptionRef = useRef('');

  const [activeTab, setActiveTab] = useState(initialTab);
  const [search, setSearch] = useState('');
  const [userId, setUserId] = useState('guest');
  const [toast, setToast] = useState(null);
  const [livePrices, setLivePrices] = useState({});
  const [streamStatus, setStreamStatus] = useState('Connecting...');

  const [headlines, setHeadlines] = useState([]);
  const [newsCategory, setNewsCategory] = useState('business');
  const [newsStatus, setNewsStatus] = useState('Loading live headlines...');
  const [summarizingUrl, setSummarizingUrl] = useState('');

  const [stockSymbol, setStockSymbol] = useState('AAPL');
  const [stockSearchInput, setStockSearchInput] = useState('AAPL');
  const [stock, setStock] = useState(null);
  const [stockPrediction, setStockPrediction] = useState(null);
  const [stockRange, setStockRange] = useState('1M');
  const [stockStatus, setStockStatus] = useState('Loading AAPL...');

  const [cryptoList, setCryptoList] = useState([]);
  const [selectedCryptoId, setSelectedCryptoId] = useState('bitcoin');
  const [cryptoDetail, setCryptoDetail] = useState(null);
  const [cryptoHistory, setCryptoHistory] = useState([]);
  const [cryptoStatus, setCryptoStatus] = useState('Loading crypto markets...');

  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState('');
  const [aiStatus, setAiStatus] = useState('Ask a market question to begin.');
  const [marketInsight, setMarketInsight] = useState('Loading today\'s summary...');
  const [marketInsightStatus, setMarketInsightStatus] = useState('');

  const [watchlist, setWatchlist] = useState({
    stocks: [],
    crypto: [],
    savedNews: [],
  });
  const [watchlistStatus, setWatchlistStatus] = useState('Watchlist ready.');

  const [alertTarget, setAlertTarget] = useState('');
  const [alertType, setAlertType] = useState('above');
  const [alerts, setAlerts] = useState([]);

  function notify(message, type = 'info') {
    window.clearTimeout(toastTimer.current);
    setToast({ message, type });
    toastTimer.current = window.setTimeout(() => setToast(null), 3600);
  }

  async function loadWatchlist() {
    try {
      const response = await api.get('/api/watchlist');
      setWatchlist(response.data.watchlist);
      setWatchlistStatus(
        response.data.owner === 'guest'
          ? 'Guest watchlist is private to this browser while the server is running.'
          : `Watchlist synced for ${response.data.owner}.`
      );
    } catch (error) {
      setWatchlistStatus('Watchlist is unavailable right now.');
    }
  }

  async function loadNews(category = newsCategory, showToast = false) {
    setNewsStatus('Loading headlines...');

    try {
      const request =
        category === 'crypto'
          ? api.get('/api/news', {
              params: { q: 'crypto bitcoin ethereum market', category: 'crypto', limit: 12 },
            })
          : category === 'finance'
          ? api.get('/api/news', {
              params: { q: 'financial markets stocks economy', category: 'finance', limit: 12 },
            })
          : api.get(`/api/news/headlines/us`, {
              params: { category, limit: 12 },
            });
      const response = await request;
      const articles = response.data.articles || [];

      setHeadlines(articles);
      setNewsStatus(response.data.message || response.data.attribution || 'Headlines updated.');

      if (showToast) {
        notify(`Updated ${articles.length} ${category} headlines.`);
      }

      return articles;
    } catch (error) {
      setNewsStatus('News is unavailable right now.');
      notify('Could not load news headlines.', 'error');
      return [];
    }
  }

  async function searchNewsTopic(query) {
    const topic = String(query || '').trim();

    if (!topic) {
      return loadNews(newsCategory, true);
    }

    setActiveTab('news');
    setNewsStatus(`Searching news for "${topic}"...`);

    try {
      const response = await api.get('/api/news', {
        params: { q: topic, limit: 12, category: newsCategory },
      });

      setHeadlines(response.data.articles || []);
      setNewsStatus(response.data.message || response.data.attribution || `Search complete for "${topic}".`);
      return response.data.articles || [];
    } catch (error) {
      setNewsStatus('News search failed.');
      notify('Could not search news right now.', 'error');
      return [];
    }
  }

  async function summarizeArticle(article) {
    const articleKey = article.url || article.title;
    setSummarizingUrl(articleKey);

    try {
      const response = await api.post('/api/ai/summarize-news', {
        title: article.title,
        description: article.description,
        content: article.content,
      });
      const summary = response.data.summary;

      setHeadlines((current) =>
        current.map((item) =>
          (item.url || item.title) === articleKey ? { ...item, summary } : item
        )
      );
      notify(response.data.status === 'gemini' ? 'AI summary ready.' : 'Fallback summary ready.');
    } catch (error) {
      notify('Could not summarize this article.', 'error');
    } finally {
      setSummarizingUrl('');
    }
  }

  async function resolveStockQuery(query) {
    const text = cleanSearchInput(query);
    const lower = text.toLowerCase();
    const directSymbol = cleanSymbol(text);
    const looksLikeTicker = directSymbol && /^[a-z0-9.]{1,5}$/i.test(text);

    if (stockNameMap[lower]) {
      return { symbol: stockNameMap[lower], name: lower };
    }

    try {
      const response = await api.get(`/api/stock/search/${encodeURIComponent(text)}`);
      const results = response.data.results || [];
      return (
        results.find((result) => result.symbol === directSymbol) ||
        results[0] ||
        (looksLikeTicker ? { symbol: directSymbol } : null)
      );
    } catch (error) {
      return looksLikeTicker ? { symbol: directSymbol } : null;
    }
  }

  async function searchAndLoadStock(query) {
    const text = cleanSearchInput(query);

    if (!text) {
      notify('Enter a stock ticker or company name.', 'error');
      return false;
    }

    setActiveTab('stocks');
    setStockStatus(`Searching stocks for "${text}"...`);

    const match = await resolveStockQuery(text);

    if (!match?.symbol) {
      setStockStatus(`No stock match found for "${text}".`);
      return false;
    }

    const loadedStock = await loadStock(match.symbol, match);
    return Boolean(loadedStock);
  }

  function subscribeToStock(symbol) {
    const previousSymbol = stockSubscriptionRef.current;
    stockSubscriptionRef.current = symbol;
    const socket = socketRef.current;
    if (!socket?.connected || !symbol) return;

    if (previousSymbol && previousSymbol !== symbol) {
      socket.emit('unsubscribe', { assetType: 'stock', symbol: previousSymbol });
    }

    socket.emit('subscribe', { assetType: 'stock', symbol });
  }

  function subscribeToCrypto(coin) {
    const previousId = cryptoSubscriptionRef.current;
    cryptoSubscriptionRef.current = coin?.id || '';
    const socket = socketRef.current;
    if (!socket?.connected || !coin?.id || !coin?.symbol) return;

    if (previousId && previousId !== coin.id) {
      socket.emit('unsubscribe', { assetType: 'crypto', id: previousId });
    }

    socket.emit('subscribe', { assetType: 'crypto', id: coin.id, symbol: coin.symbol });
  }

  async function loadStock(symbol = stockSymbol, metadata = {}) {
    const safeSymbol = cleanSymbol(symbol);

    if (!safeSymbol) {
      notify('Enter a valid stock symbol.', 'error');
      return null;
    }

    setActiveTab((current) => (current === 'dashboard' ? current : 'stocks'));
    setStockStatus(`Loading ${safeSymbol}...`);
    setStockSymbol(safeSymbol);
    setStockSearchInput(safeSymbol);

    try {
      const [stockResult, predictionResult] = await Promise.allSettled([
        api.get(`/api/stock/${safeSymbol}`),
        api.get(`/api/stock/${safeSymbol}/predict`),
      ]);

      if (stockResult.status !== 'fulfilled') {
        throw stockResult.reason;
      }

      const nextStock = {
        ...stockResult.value.data,
        name: stockResult.value.data.name || metadata.name || safeSymbol,
        region: stockResult.value.data.region || metadata.region || '',
        currency: stockResult.value.data.currency || metadata.currency || 'USD',
      };
      setStock(nextStock);

      if (predictionResult.status === 'fulfilled') {
        setStockPrediction(predictionResult.value.data);
      } else {
        setStockPrediction(null);
      }

      setStockStatus(
        nextStock.message
          ? `${nextStock.attribution || `${safeSymbol} loaded.`} ${nextStock.message}`
          : nextStock.attribution || `${safeSymbol} loaded.`
      );

      subscribeToStock(safeSymbol);

      return nextStock;
    } catch (error) {
      setStockStatus(`Could not load ${safeSymbol}.`);
      notify(`Could not load ${safeSymbol}.`, 'error');
      return null;
    }
  }

  async function loadCryptos() {
    setCryptoStatus('Loading top crypto markets...');

    try {
      const response = await api.get('/api/crypto/top', { params: { limit: 10 } });
      const coins = response.data.data || [];

      setCryptoList(coins);
      setCryptoStatus(response.data.message || response.data.attribution || 'Crypto prices updated.');

      if (coins[0] && !cryptoDetail) {
        await loadCryptoDetail(coins[0].id);
      } else if (!coins.length) {
        setCryptoDetail(null);
        setCryptoHistory([]);
      }

      return coins;
    } catch (error) {
      setCryptoStatus('Crypto markets are unavailable right now.');
      notify('Could not load crypto markets.', 'error');
      return [];
    }
  }

  async function loadCryptoDetail(id = selectedCryptoId) {
    const safeId = String(id || '').trim().toLowerCase();

    if (!safeId) {
      return null;
    }

    setActiveTab((current) => (current === 'dashboard' ? current : 'crypto'));
    setSelectedCryptoId(safeId);
    setCryptoDetail(null);
    setCryptoHistory([]);
    setCryptoStatus(`Loading ${safeId}...`);

    try {
      const [detailResult, historyResult] = await Promise.allSettled([
        api.get(`/api/crypto/${encodeURIComponent(safeId)}`),
        api.get(`/api/crypto/${encodeURIComponent(safeId)}/history`, {
          params: { days: 7 },
        }),
      ]);

      if (detailResult.status !== 'fulfilled') {
        throw detailResult.reason;
      }

      const detail = detailResult.value.data;
      setCryptoDetail(detail);

      if (historyResult.status === 'fulfilled') {
        setCryptoHistory(historyResult.value.data.prices || []);
      } else {
        setCryptoHistory([]);
      }

      setCryptoStatus(detail.message || detail.attribution || 'Crypto detail updated.');
      subscribeToCrypto(detail);
      return detail;
    } catch (error) {
      setCryptoStatus('Could not load this crypto asset.');
      notify('Could not load crypto details.', 'error');
      return null;
    }
  }

  function currentMarketData() {
    const latestStockPoint = stock?.data?.[stock.data.length - 1];

    return {
      stock: stock
        ? {
            symbol: stock.symbol,
            latestPrice: stock.latestPrice,
            dailyChangePercent: stock.dailyChangePercent,
            volume: latestStockPoint?.volume,
            source: stock.source,
          }
        : null,
      crypto: cryptoList.slice(0, 4).map((coin) => ({
        symbol: coin.symbol,
        price: coin.currentPrice,
        change: coin.priceChangePercent24h,
        volume24h: coin.volume24h,
      })),
      headlines: headlines.slice(0, 4).map((article) => article.title),
    };
  }

  async function askAI(question = aiQuestion, type = 'general') {
    const text = String(question || '').trim();

    if (!text) {
      notify('Ask the AI a question first.', 'error');
      return;
    }

    setActiveTab('ai');
    setAiStatus('Thinking with Gemini or the safe local fallback...');

    try {
      const response = await api.post('/api/ai/explain', {
        text,
        type,
        marketData: currentMarketData(),
      });
      setAiAnswer(response.data.explanation);
      setAiStatus(
        response.data.status === 'gemini'
          ? response.data.attribution
          : `${response.data.message || 'Gemini unavailable.'} Local educational response shown.`
      );
    } catch (error) {
      setAiAnswer('The AI assistant is unavailable right now. Please try again in a moment.');
      setAiStatus('AI request failed.');
    }
  }

  async function loadMarketInsight() {
    const marketData = currentMarketData();

    try {
      const response = await api.post('/api/ai/market-insight', { marketData });
      setMarketInsight(response.data.insight);
      setMarketInsightStatus(
        response.data.status === 'gemini'
          ? response.data.attribution
          : response.data.message || 'Local educational summary shown.'
      );
    } catch (error) {
      setMarketInsight(
        'Markets are mixed today. Compare price changes with the latest headlines before drawing conclusions.'
      );
      setMarketInsightStatus('AI summary unavailable.');
    }
  }

  async function addToWatchlist(type, item) {
    try {
      const payload =
        type === 'news'
          ? {
              type: 'news',
              symbol: item.title,
              name: item.title,
              url: item.url,
            }
          : {
              type,
              symbol: item.symbol || item.id,
              id: item.id,
              name: item.name || item.symbol,
              price: item.latestPrice || item.currentPrice || item.price,
            };
      const response = await api.post('/api/watchlist/add', payload);

      setWatchlist(response.data.watchlist);
      notify(`${payload.name} saved to watchlist.`);
    } catch (error) {
      notify('Could not save this item.', 'error');
    }
  }

  async function removeFromWatchlist(type, item) {
    try {
      const response = await api.delete('/api/watchlist/remove', {
        data: {
          type,
          symbol: type === 'news' ? '' : item.symbol || item.id || item.name,
          id: item.id,
        },
      });

      setWatchlist(response.data.watchlist);
      notify('Removed from watchlist.');
    } catch (error) {
      notify('Could not remove this item.', 'error');
    }
  }

  async function runUnifiedSearch(event) {
    event.preventDefault();
    const query = search.trim();
    const lower = query.toLowerCase();

    if (!query) {
      notify('Type a stock, crypto, news topic, or AI question.');
      return;
    }

    const looksLikeQuestion =
      query.endsWith('?') ||
      /^(why|what|how|should|explain|summarize|compare|is)\b/i.test(query);

    if (looksLikeQuestion) {
      setAiQuestion(query);
      askAI(query, lower.includes('chart') ? 'chart-explanation' : 'general');
      return;
    }

    if (/\b(news|headline|headlines|article|articles)\b/i.test(query)) {
      searchNewsTopic(query);
      return;
    }

    if (stockNameMap[lower] || /^[A-Z]{1,5}$/.test(query)) {
      searchAndLoadStock(query);
      return;
    }

    if (cryptoNameMap[lower]) {
      setActiveTab('crypto');
      loadCryptoDetail(cryptoNameMap[lower]);
      return;
    }

    const stockFound = await searchAndLoadStock(query);
    if (stockFound) {
      return;
    }

    searchNewsTopic(query);
  }

  function setPriceAlert(event) {
    event.preventDefault();
    const symbol = cleanSymbol(stockSymbol);
    const target = Number(alertTarget);

    if (!socketRef.current || !symbol || !Number.isFinite(target) || target <= 0) {
      notify('Enter a valid alert target first.', 'error');
      return;
    }

    socketRef.current.emit('set-alert', {
      assetType: 'stock',
      symbol,
      target,
      type: alertType,
    });
  }

  function stockChartData() {
    const data = stock?.data || [];
    const countByRange = { '1D': 2, '1W': 7, '1M': 30 };

    return data.slice(-countByRange[stockRange]).map((point) => ({
      ...point,
      label: point.date?.slice(5) || '',
    }));
  }

  function dashboardMovers() {
    const cryptoMovers = cryptoList
      .filter(
        (coin) =>
          Number.isFinite(Number(coin.currentPrice)) &&
          Number.isFinite(Number(coin.priceChangePercent24h))
      )
      .map((coin) => ({
        type: 'Crypto',
        label: coin.symbol,
        name: coin.name,
        price: coin.currentPrice,
        change: coin.priceChangePercent24h,
      }));
    const stockMover =
      stock?.isRealData &&
      Number.isFinite(Number(stock.latestPrice)) &&
      Number.isFinite(Number(stock.dailyChangePercent))
      ? [
          {
            type: 'Stock',
            label: stock.symbol,
            name: stock.name,
            price: stock.latestPrice,
            change: stock.dailyChangePercent,
          },
        ]
      : [];

    return [...stockMover, ...cryptoMovers]
      .sort((a, b) => Math.abs(Number(b.change)) - Math.abs(Number(a.change)))
      .slice(0, 5);
  }

  useEffect(() => {
    api.get('/api/auth/verify')
      .then((response) => setUserId(response.data.user.email))
      .catch(() => setUserId('guest'));
    loadWatchlist();
    loadNews('business');
    loadStock('AAPL');
    loadCryptos();
  }, []);

  useEffect(() => {
    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnectionAttempts: 5,
    });

    socketRef.current = socket;

    socket.on('connect', () => {
      setLivePrices((current) => ({ ...current, status: 'connected' }));
      setStreamStatus('Connected; waiting for market quote.');
      const initialStock = stockSubscriptionRef.current || 'AAPL';
      stockSubscriptionRef.current = initialStock;
      socket.emit('subscribe', { assetType: 'stock', symbol: initialStock });
      if (cryptoSubscriptionRef.current) {
        socket.emit('subscribe', { assetType: 'crypto', id: cryptoSubscriptionRef.current });
      }
    });

    socket.on('price-update', (data) => {
      setLivePrices((current) => ({
        ...current,
        [data.key]: data,
      }));
      setStreamStatus(`Quotes from ${data.source}.`);

      setStock((current) => {
        if (!current || data.assetType !== 'stock' || current.symbol !== data.symbol) {
          return current;
        }

        return {
          ...current,
          latestPrice: data.price,
          dailyChangePercent: data.change,
        };
      });

      if (data.assetType === 'crypto') {
        setCryptoList((current) =>
          current.map((coin) =>
            coin.id === data.id
              ? { ...coin, currentPrice: data.price, priceChangePercent24h: data.change }
              : coin
          )
        );
        setCryptoDetail((current) =>
          current?.id === data.id
            ? { ...current, currentPrice: data.price, priceChangePercent24h: data.change }
            : current
        );
      }
    });

    socket.on('stream-status', (data) => {
      if (data.status === 'unavailable') {
        setStreamStatus(data.message);
        setLivePrices((current) => {
          if (!data.key || !current[data.key]) {
            return current;
          }

          const nextPrices = { ...current };
          delete nextPrices[data.key];
          return nextPrices;
        });
      }
    });

    socket.on('alert-set', (data) => {
      setAlerts((current) => [data.alert, ...current].slice(0, 8));
      setAlertTarget('');
      notify('Price alert is active.');
    });

    socket.on('alert-triggered', (data) => {
      notify(data.message, 'success');
      setAlerts((current) =>
        current.map((alert) =>
          alert.symbol === data.symbol && Number(alert.target) === Number(data.target)
            ? { ...alert, triggered: true, currentPrice: data.price }
            : alert
        )
      );
    });

    socket.on('alert-error', (data) => {
      notify(data.message || 'Alert failed.', 'error');
    });

    socket.on('disconnect', () => {
      setStreamStatus('Real-time connection offline.');
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
      stockSubscriptionRef.current = '';
      cryptoSubscriptionRef.current = '';
    };
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => loadNews(newsCategory), 3 * 60 * 1000);
    return () => window.clearInterval(interval);
  }, [newsCategory]);

  useEffect(() => {
    if (headlines.length || cryptoList.length || stock) {
      loadMarketInsight();
    }
  }, [headlines.length, cryptoList.length, stock?.symbol]);

  const currentLivePrice = livePrices[`stock:${stockSymbol}`];
  const currentCryptoPrice = cryptoDetail
    ? livePrices[`crypto:${cryptoDetail.id}`]
    : null;
  const chartData = stockChartData();
  const movers = dashboardMovers();
  const cryptoChartData = cryptoHistory.map((point) => ({
    ...point,
    label: formatDate(point.time),
  }));

  return (
    <main className="min-h-screen overflow-hidden bg-[#07120f] text-stone-50">
      <div className="pointer-events-none fixed inset-0 opacity-80">
        <div className="absolute left-[-10%] top-[-15%] h-96 w-96 rounded-full bg-emerald-500/20 blur-3xl" />
        <div className="absolute right-[-8%] top-[12%] h-[28rem] w-[28rem] rounded-full bg-amber-400/10 blur-3xl" />
        <div className="absolute bottom-[-16%] left-[25%] h-[34rem] w-[34rem] rounded-full bg-sky-500/10 blur-3xl" />
      </div>

      <div className="relative mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-5 sm:px-6 lg:px-8">
        <header className="rounded-[2.25rem] border border-white/10 bg-white/[0.04] p-5 shadow-2xl shadow-black/30 backdrop-blur md:p-7">
          <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <p className="mb-3 inline-flex rounded-full border border-emerald-300/30 bg-emerald-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.28em] text-emerald-200">
                NexTrade
              </p>
              <h1 className="max-w-3xl text-4xl font-black tracking-[-0.05em] text-stone-50 md:text-6xl">
                Markets, news, crypto, and AI in one calm cockpit.
              </h1>
              <p className="mt-4 max-w-2xl text-sm leading-6 text-stone-300 md:text-base">
                Search once to jump into stocks, crypto, news, or Gemini-powered plain-English explanations. Market prices are shown only when a live provider responds.
              </p>
            </div>

            <div className="grid gap-3 rounded-3xl border border-white/10 bg-slate-950/60 p-4 text-sm text-stone-300 sm:grid-cols-3 lg:min-w-[26rem]">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Socket</p>
                <p className="mt-1 font-semibold text-emerald-200">
                  {livePrices.status === 'connected' ? 'Connected' : 'Connecting'}
                </p>
                <p className="mt-1 text-[11px] leading-4 text-stone-500">{streamStatus}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">User</p>
                <p className="mt-1 truncate font-semibold text-stone-100">{userId}</p>
              </div>
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Safety</p>
                <p className="mt-1 font-semibold text-amber-200">Info only</p>
              </div>
            </div>
          </div>

          <form onSubmit={runUnifiedSearch} className="mt-7 grid gap-3 md:grid-cols-[1fr_auto]">
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search AAPL, Tesla, Bitcoin, tech news, or ask: Why is Bitcoin moving?"
              className="h-14 rounded-2xl border border-white/10 bg-black/30 px-5 text-base text-white outline-none ring-emerald-300/0 transition focus:border-emerald-200/60 focus:ring-4 focus:ring-emerald-300/10"
            />
            <button className="h-14 rounded-2xl bg-emerald-300 px-7 font-black text-emerald-950 shadow-lg shadow-emerald-950/30 transition hover:bg-emerald-200">
              Search
            </button>
          </form>

          <nav className="mt-6 flex gap-2 overflow-x-auto pb-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition ${
                  activeTab === tab.id
                    ? 'bg-stone-50 text-slate-950'
                    : 'border border-white/10 bg-white/[0.04] text-stone-300 hover:bg-white/[0.08]'
                }`}
              >
                {tab.label}
              </button>
            ))}
            <Link
              href="/login"
              className="ml-auto whitespace-nowrap rounded-full border border-amber-200/30 bg-amber-200/10 px-4 py-2 text-sm font-bold text-amber-100 transition hover:bg-amber-200/20"
            >
              Login
            </Link>
          </nav>
        </header>

        {toast && (
          <div
            className={`fixed right-4 top-4 z-50 max-w-sm rounded-2xl border px-4 py-3 text-sm font-semibold shadow-2xl ${
              toast.type === 'error'
                ? 'border-rose-300/40 bg-rose-950 text-rose-100'
                : toast.type === 'success'
                ? 'border-emerald-300/40 bg-emerald-950 text-emerald-100'
                : 'border-white/15 bg-slate-950 text-stone-100'
            }`}
          >
            {toast.message}
          </div>
        )}

        {activeTab === 'dashboard' && (
          <section className="grid gap-5 lg:grid-cols-[1.2fr_0.8fr]">
            <div className={panelClass('min-h-[24rem]')}>
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-200">Today summary</p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight">AI market pulse</h2>
                </div>
                <button
                  onClick={loadMarketInsight}
                  className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-stone-200 hover:bg-white/10"
                >
                  Refresh insight
                </button>
              </div>
              <p className="mt-5 rounded-3xl border border-emerald-300/20 bg-emerald-300/10 p-5 text-lg leading-8 text-emerald-50">
                {marketInsight}
              </p>
              {marketInsightStatus && (
                <p className="mt-2 text-xs text-stone-400">{marketInsightStatus}</p>
              )}

              <div className="mt-6 grid gap-4 md:grid-cols-3">
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Stock focus</p>
                  <p className="mt-2 text-2xl font-black">{stock?.symbol || 'AAPL'}</p>
                  <p className="text-sm text-stone-300">
                    {formatCurrency(currentLivePrice?.price ?? stock?.latestPrice)}
                  </p>
                  <p className={`mt-1 text-sm font-bold ${trendClass(stock?.dailyChangePercent)}`}>
                    {formatPercent(stock?.dailyChangePercent)}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">{stock?.source || 'Awaiting source'}</p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Crypto leader</p>
                  <p className="mt-2 text-2xl font-black">{cryptoList[0]?.symbol || '--'}</p>
                  <p className="text-sm text-stone-300">{formatCurrency(cryptoList[0]?.currentPrice)}</p>
                  <p className={`mt-1 text-sm font-bold ${trendClass(cryptoList[0]?.priceChangePercent24h)}`}>
                    {formatPercent(cryptoList[0]?.priceChangePercent24h)}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">CoinGecko</p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Headlines</p>
                  <p className="mt-2 text-2xl font-black">{headlines.length}</p>
                  <p className="text-sm text-stone-300">Auto-refreshes every few minutes</p>
                </div>
              </div>

              <div className="mt-6">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="font-black">Biggest movers</h3>
                  <p className="text-xs text-stone-500">Stocks plus crypto</p>
                </div>
                <div className="grid gap-3">
                  {!movers.length && (
                    <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-stone-400">
                      Live market movers are unavailable until price providers respond.
                    </p>
                  )}
                  {movers.map((mover) => (
                    <div
                      key={`${mover.type}-${mover.label}`}
                      className="grid grid-cols-[1fr_auto_auto] items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-3"
                    >
                      <div>
                        <p className="font-black">{mover.label}</p>
                        <p className="text-xs text-stone-400">{mover.name}</p>
                      </div>
                      <p className="text-sm font-semibold text-stone-200">{formatCurrency(mover.price)}</p>
                      <p className={`text-sm font-black ${trendClass(mover.change)}`}>
                        {formatPercent(mover.change)}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid gap-5">
              <div className={panelClass()}>
                <div className="flex items-center justify-between">
                  <h2 className="text-xl font-black">Top headlines</h2>
                  <button
                    onClick={() => {
                      setActiveTab('news');
                      loadNews(newsCategory, true);
                    }}
                    className="text-sm font-bold text-emerald-200"
                  >
                    View all
                  </button>
                </div>
                <div className="mt-4 grid gap-3">
                  {!headlines.length && (
                    <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-stone-400">
                      No live headlines are available right now.
                    </p>
                  )}
                  {headlines.slice(0, 4).map((article) => (
                    <a
                      key={article.url || article.title}
                      href={article.url || '#'}
                      target={article.url ? '_blank' : undefined}
                      rel="noreferrer"
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-4 transition hover:bg-white/[0.08]"
                    >
                      <p className="text-xs uppercase tracking-[0.2em] text-amber-200">{article.source}</p>
                      <h3 className="mt-2 font-black leading-5">{article.title}</h3>
                      <p className="mt-2 text-xs text-stone-400">{formatDate(article.publishedAt)}</p>
                    </a>
                  ))}
                </div>
              </div>

              <div className={panelClass()}>
                <h2 className="text-xl font-black">Quick AI prompts</h2>
                <div className="mt-4 grid gap-2">
                  {[
                    'Summarize today\'s tech news',
                    'Compare Bitcoin vs Ethereum',
                    `Explain ${stock?.symbol || 'AAPL'} in simple terms`,
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      onClick={() => {
                        setAiQuestion(prompt);
                        askAI(prompt, 'general');
                      }}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left text-sm font-bold text-stone-200 hover:bg-white/[0.08]"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'news' && (
          <section className={panelClass()}>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-amber-200">Live news feed</p>
                <h2 className="mt-2 text-3xl font-black tracking-tight">Headlines and AI summaries</h2>
                <p className="mt-2 text-sm text-stone-400">{newsStatus}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                {newsCategories.map((category) => (
                  <button
                    key={category}
                    onClick={() => {
                      setNewsCategory(category);
                      loadNews(category, true);
                    }}
                    className={`rounded-full px-4 py-2 text-sm font-bold capitalize ${
                      newsCategory === category
                        ? 'bg-amber-200 text-amber-950'
                        : 'border border-white/10 bg-white/[0.04] text-stone-300'
                    }`}
                  >
                    {category}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {!headlines.length && (
                <p className="rounded-2xl border border-dashed border-white/10 p-5 text-sm text-stone-300 md:col-span-2 xl:col-span-3">
                  No live articles are available. Check your NewsAPI key or try again later.
                </p>
              )}
              {headlines.map((article) => (
                <article
                  key={article.url || article.title}
                  className="flex min-h-[20rem] flex-col rounded-[1.5rem] border border-white/10 bg-black/20 p-4"
                >
                  {article.image ? (
                    <img
                      src={article.image}
                      alt=""
                      className="mb-4 h-36 w-full rounded-2xl object-cover"
                    />
                  ) : (
                    <div className="mb-4 flex h-36 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-300/20 to-amber-200/10 text-sm font-bold text-stone-400">
                      Market story
                    </div>
                  )}
                  <p className="text-xs uppercase tracking-[0.22em] text-amber-200">{article.source}</p>
                  <h3 className="mt-2 text-lg font-black leading-6">{article.title}</h3>
                  <p className="mt-3 line-clamp-3 text-sm leading-6 text-stone-300">{article.description}</p>
                  {article.summary && (
                    <p className="mt-3 rounded-2xl border border-emerald-300/20 bg-emerald-300/10 p-3 text-sm leading-6 text-emerald-50">
                      {article.summary}
                    </p>
                  )}
                  <div className="mt-auto flex flex-wrap gap-2 pt-4">
                    <button
                      onClick={() => summarizeArticle(article)}
                      disabled={summarizingUrl === (article.url || article.title)}
                      className="rounded-full bg-emerald-300 px-4 py-2 text-sm font-black text-emerald-950 disabled:opacity-60"
                    >
                      {summarizingUrl === (article.url || article.title) ? 'Summarizing...' : 'AI summary'}
                    </button>
                    <button
                      onClick={() => addToWatchlist('news', article)}
                      className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-stone-200"
                    >
                      Save
                    </button>
                    {article.url && (
                      <a
                        href={article.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-stone-200"
                      >
                        Open story
                      </a>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'stocks' && (
          <section className="grid gap-5 lg:grid-cols-[1fr_0.78fr]">
            <div className={panelClass()}>
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-200">Stock tracker</p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight">
                    {stock?.name || stockSymbol} ({stock?.symbol || stockSymbol})
                  </h2>
                  <p className="mt-2 text-sm text-stone-400">{stockStatus}</p>
                  {stock && !stock.isRealData && (
                    <p className="mt-2 inline-flex rounded-full bg-amber-200/10 px-3 py-1 text-xs font-bold text-amber-200">
                      Live stock pricing unavailable
                    </p>
                  )}
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    searchAndLoadStock(stockSearchInput);
                  }}
                  className="flex gap-2"
                >
                  <input
                    value={stockSearchInput}
                    onChange={(event) => setStockSearchInput(event.target.value.slice(0, 80))}
                    className="h-11 w-52 rounded-xl border border-white/10 bg-black/30 px-3 font-black text-white outline-none"
                    placeholder="AAPL or Walmart"
                  />
                  <button className="h-11 rounded-xl bg-emerald-300 px-4 font-black text-emerald-950">
                    Track
                  </button>
                </form>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-4">
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Price</p>
                  <p className="mt-2 text-3xl font-black">
                    {formatCurrency(currentLivePrice?.price ?? stock?.latestPrice)}
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Daily change</p>
                  <p className={`mt-2 text-3xl font-black ${trendClass(stock?.dailyChangePercent)}`}>
                    {formatPercent(stock?.dailyChangePercent)}
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">
                    Next-session estimate
                  </p>
                  <p className="mt-2 text-3xl font-black">
                    {formatCurrency(stockPrediction?.predictedPrice)}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">
                    {stockPrediction?.estimatedLow && stockPrediction?.estimatedHigh
                      ? `${formatCurrency(stockPrediction.estimatedLow)} - ${formatCurrency(
                          stockPrediction.estimatedHigh
                        )}`
                      : 'Estimated range unavailable'}
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Quote change</p>
                  <p className="mt-2 text-3xl font-black">
                    {currentLivePrice ? formatPercent(currentLivePrice.change) : 'Waiting'}
                  </p>
                  <p className="mt-1 text-[11px] text-stone-500">
                    {currentLivePrice?.source || 'Waiting for provider'}
                  </p>
                </div>
              </div>

              {stockPrediction && (
                <div className="mt-5 rounded-[1.5rem] border border-emerald-200/15 bg-emerald-300/[0.06] p-4 text-sm text-stone-300">
                  <p className="font-black text-emerald-100">
                    {stockPrediction.horizon} | signal: {stockPrediction.direction || 'uncertain'}
                  </p>
                  <p className="mt-2 leading-6">
                    {stockPrediction.method}. Walk-forward error:{' '}
                    {formatErrorPercent(stockPrediction.backtestMaePercent)} versus{' '}
                    {formatErrorPercent(stockPrediction.baselineMaePercent)} for the baseline across{' '}
                    {stockPrediction.validationPoints || 0} historical checkpoints. Reliability:{' '}
                    {stockPrediction.reliability || 'limited'}.
                  </p>
                  <p className="mt-2 text-xs text-stone-400">
                    History: {stockPrediction.historySource || 'provider unavailable'} | Estimate
                    anchored to: {stockPrediction.currentPriceSource || 'provider unavailable'}
                  </p>
                </div>
              )}

              <div className="mt-6 rounded-[1.5rem] border border-white/10 bg-black/20 p-4">
                <div className="mb-4 flex items-center justify-between">
                  <h3 className="font-black">Mini chart</h3>
                  <div className="flex gap-2">
                    {['1D', '1W', '1M'].map((range) => (
                      <button
                        key={range}
                        onClick={() => setStockRange(range)}
                        className={`rounded-full px-3 py-1 text-xs font-black ${
                          stockRange === range
                            ? 'bg-stone-50 text-slate-950'
                            : 'border border-white/10 text-stone-300'
                        }`}
                      >
                        {range}
                      </button>
                    ))}
                  </div>
                </div>
                {chartData.length ? (
                <div className="h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={chartData}>
                      <defs>
                        <linearGradient id="stockGradient" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="5%" stopColor="#6ee7b7" stopOpacity={0.45} />
                          <stop offset="95%" stopColor="#6ee7b7" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                      <XAxis dataKey="label" stroke="#a8a29e" tick={{ fontSize: 12 }} />
                      <YAxis stroke="#a8a29e" tick={{ fontSize: 12 }} domain={['auto', 'auto']} />
                      <Tooltip
                        contentStyle={{
                          background: '#07120f',
                          border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: 16,
                        }}
                        formatter={(value) => [formatCurrency(value), 'Close']}
                      />
                      <Area
                        type="monotone"
                        dataKey="close"
                        stroke="#6ee7b7"
                        strokeWidth={3}
                        fill="url(#stockGradient)"
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                ) : (
                  <p className="flex h-72 items-center justify-center text-sm text-stone-400">
                    Live chart data is unavailable.
                  </p>
                )}
              </div>
            </div>

            <aside className="grid gap-5">
              <div className={panelClass()}>
                <h3 className="text-xl font-black">AI stock explainer</h3>
                <p className="mt-2 text-sm leading-6 text-stone-400">
                  Ask Gemini to turn the chart and price movement into simple language.
                </p>
                <button
                  onClick={() =>
                    askAI(
                      `Explain ${stock?.symbol || stockSymbol}. Price: ${stock?.latestPrice}. Daily change: ${stock?.dailyChangePercent}%. Next-session historical estimate: ${stockPrediction?.predictedPrice}, estimated range: ${stockPrediction?.estimatedLow} to ${stockPrediction?.estimatedHigh}, reliability: ${stockPrediction?.reliability || 'limited'}.`,
                      'stock-movement'
                    )
                  }
                  disabled={!stock?.latestPrice}
                  className="mt-4 w-full rounded-2xl bg-emerald-300 px-4 py-3 font-black text-emerald-950"
                >
                  Explain this stock
                </button>
                <button
                  onClick={() => stock && addToWatchlist('stock', stock)}
                  disabled={!stock?.latestPrice}
                  className="mt-3 w-full rounded-2xl border border-white/10 px-4 py-3 font-black text-stone-200"
                >
                  Add stock to watchlist
                </button>
                <p className="mt-3 text-xs leading-5 text-stone-500">
                  {stockPrediction?.disclaimer || 'Predictions are informational only and not financial advice.'}
                </p>
              </div>

              <div className={panelClass()}>
                <h3 className="text-xl font-black">Provider price alert</h3>
                <form onSubmit={setPriceAlert} className="mt-4 grid gap-3">
                  <select
                    value={alertType}
                    onChange={(event) => setAlertType(event.target.value)}
                    className="h-11 rounded-xl border border-white/10 bg-black/30 px-3 text-white outline-none"
                  >
                    <option value="above">Alert when above</option>
                    <option value="below">Alert when below</option>
                  </select>
                  <input
                    value={alertTarget}
                    onChange={(event) => setAlertTarget(event.target.value)}
                    inputMode="decimal"
                    placeholder="Target price"
                    className="h-11 rounded-xl border border-white/10 bg-black/30 px-3 text-white outline-none"
                  />
                  <button className="h-11 rounded-xl bg-amber-200 font-black text-amber-950">
                    Set alert
                  </button>
                </form>
                <div className="mt-4 grid gap-2">
                  {alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className="rounded-2xl border border-white/10 bg-white/[0.04] p-3 text-sm"
                    >
                      <p className="font-black">
                        {alert.symbol} {alert.type} {formatCurrency(alert.target)}
                      </p>
                      <p className={alert.triggered ? 'text-emerald-200' : 'text-stone-400'}>
                        {alert.triggered ? 'Triggered' : 'Watching provider quote stream'}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            </aside>
          </section>
        )}

        {activeTab === 'crypto' && (
          <section className="grid gap-5 lg:grid-cols-[0.85fr_1.15fr]">
            <div className={panelClass()}>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-200">Crypto tracker</p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight">Top coins</h2>
                </div>
                <button
                  onClick={loadCryptos}
                  className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-stone-200"
                >
                  Refresh
                </button>
              </div>
              <p className="mt-2 text-sm text-stone-400">{cryptoStatus}</p>
              <div className="mt-5 grid gap-3">
                {!cryptoList.length && (
                  <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-stone-400">
                    No live crypto quotes are available. Try again when CoinGecko responds.
                  </p>
                )}
                {cryptoList.map((coin) => (
                  <button
                    key={coin.id}
                    onClick={() => loadCryptoDetail(coin.id)}
                    className={`grid grid-cols-[1fr_auto] items-center gap-3 rounded-2xl border p-3 text-left transition ${
                      selectedCryptoId === coin.id
                        ? 'border-sky-200/50 bg-sky-300/10'
                        : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      {coin.image ? (
                        <img src={coin.image} alt="" className="h-9 w-9 rounded-full" />
                      ) : (
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-sky-300/20 text-xs font-black">
                          {coin.symbol?.slice(0, 2)}
                        </div>
                      )}
                      <div>
                        <p className="font-black">{coin.name}</p>
                        <p className="text-xs text-stone-400">{coin.symbol}</p>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-black">{formatCurrency(coin.currentPrice)}</p>
                      <p className={`text-sm font-bold ${trendClass(coin.priceChangePercent24h)}`}>
                        {formatPercent(coin.priceChangePercent24h)}
                      </p>
                    </div>
                  </button>
                ))}
              </div>
              <p className="mt-4 text-xs text-stone-500">Data provided by CoinGecko.</p>
            </div>

            <div className={panelClass()}>
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.25em] text-sky-200">Coin detail</p>
                  <h2 className="mt-2 text-3xl font-black tracking-tight">
                    {cryptoDetail?.name || selectedCryptoId}
                  </h2>
                  <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-400">
                    {plainText(cryptoDetail?.description).slice(0, 220) ||
                      'Select a coin to see chart, market cap, volume, and AI context.'}
                  </p>
                </div>
                <button
                  onClick={() => cryptoDetail && addToWatchlist('crypto', cryptoDetail)}
                  className="rounded-2xl bg-sky-200 px-4 py-3 font-black text-sky-950"
                >
                  Add crypto
                </button>
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-4">
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Price</p>
                  <p className="mt-2 text-2xl font-black">
                    {formatCurrency(currentCryptoPrice?.price ?? cryptoDetail?.currentPrice)}
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">24h</p>
                  <p className={`mt-2 text-2xl font-black ${trendClass(cryptoDetail?.priceChangePercent24h)}`}>
                    {formatPercent(currentCryptoPrice?.change ?? cryptoDetail?.priceChangePercent24h)}
                  </p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Market cap</p>
                  <p className="mt-2 text-2xl font-black">{formatLargeNumber(cryptoDetail?.marketCap)}</p>
                </div>
                <div className="rounded-3xl border border-white/10 bg-white/[0.04] p-4">
                  <p className="text-xs uppercase tracking-[0.22em] text-stone-500">Volume</p>
                  <p className="mt-2 text-2xl font-black">{formatLargeNumber(cryptoDetail?.volume24h)}</p>
                </div>
              </div>

              {cryptoChartData.length ? (
              <div className="mt-6 h-80 rounded-[1.5rem] border border-white/10 bg-black/20 p-4">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={cryptoChartData}>
                    <CartesianGrid stroke="rgba(255,255,255,0.08)" vertical={false} />
                    <XAxis dataKey="label" stroke="#a8a29e" tick={{ fontSize: 11 }} minTickGap={32} />
                    <YAxis stroke="#a8a29e" tick={{ fontSize: 12 }} domain={['auto', 'auto']} />
                    <Tooltip
                      contentStyle={{
                        background: '#07120f',
                        border: '1px solid rgba(255,255,255,0.12)',
                        borderRadius: 16,
                      }}
                      formatter={(value) => [formatCurrency(value), 'Price']}
                    />
                    <Line type="monotone" dataKey="price" stroke="#7dd3fc" strokeWidth={3} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              ) : (
                <p className="mt-6 flex h-80 items-center justify-center rounded-[1.5rem] border border-dashed border-white/10 text-sm text-stone-400">
                  Historical crypto chart data is unavailable.
                </p>
              )}
            </div>
          </section>
        )}

        {activeTab === 'ai' && (
          <section className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
            <div className={panelClass()}>
              <p className="text-xs font-bold uppercase tracking-[0.25em] text-emerald-200">Gemini assistant</p>
              <h2 className="mt-2 text-3xl font-black tracking-tight">Ask in plain English</h2>
              <p className="mt-3 text-sm leading-6 text-stone-400">
                The assistant summarizes news, explains chart moves, compares assets, and keeps answers informational only.
              </p>

              <textarea
                value={aiQuestion}
                onChange={(event) => setAiQuestion(event.target.value)}
                rows={7}
                placeholder="Why is Bitcoin going up? Should I invest in Apple stock? Summarize today's technology news."
                className="mt-5 w-full rounded-2xl border border-white/10 bg-black/30 p-4 text-white outline-none focus:border-emerald-200/60"
              />
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                <button
                  onClick={() => askAI(aiQuestion, 'general')}
                  className="rounded-2xl bg-emerald-300 px-4 py-3 font-black text-emerald-950"
                >
                  Ask AI
                </button>
                <button
                  onClick={() =>
                    askAI(
                      `Explain this chart: ${stock?.symbol || stockSymbol} has price ${stock?.latestPrice} and daily change ${stock?.dailyChangePercent}%.`,
                      'chart-explanation'
                    )
                  }
                  className="rounded-2xl border border-white/10 px-4 py-3 font-black text-stone-200"
                >
                  Explain chart
                </button>
              </div>

              <div className="mt-5 grid gap-2">
                {[
                  'What changed in the market today?',
                  'Summarize today\'s tech news',
                  'Compare Bitcoin vs Ethereum',
                  'Should I invest in Apple stock? Keep it educational.',
                ].map((prompt) => (
                  <button
                    key={prompt}
                    onClick={() => {
                      setAiQuestion(prompt);
                      askAI(prompt, prompt.includes('invest') ? 'investment-question' : 'general');
                    }}
                    className="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3 text-left text-sm font-bold text-stone-200 hover:bg-white/[0.08]"
                  >
                    {prompt}
                  </button>
                ))}
              </div>
            </div>

            <div className={panelClass('flex min-h-[32rem] flex-col')}>
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-amber-200">Answer</p>
                <h2 className="mt-2 text-3xl font-black tracking-tight">Simple explanation</h2>
                <p className="mt-2 text-sm text-stone-400">{aiStatus}</p>
              </div>
              <div className="mt-6 flex-1 rounded-[1.5rem] border border-white/10 bg-black/25 p-5">
                <p className="whitespace-pre-wrap text-lg leading-8 text-stone-100">
                  {aiAnswer ||
                    'Ask a question or use a quick prompt. If Gemini is not configured, the app returns a safe local fallback so the feature still works during development.'}
                </p>
              </div>
            </div>
          </section>
        )}

        {activeTab === 'watchlist' && (
          <section className={panelClass()}>
            <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.25em] text-amber-200">Saved items</p>
                <h2 className="mt-2 text-3xl font-black tracking-tight">Watchlist</h2>
                <p className="mt-2 text-sm text-stone-400">{watchlistStatus}</p>
              </div>
              <button
                onClick={loadWatchlist}
                className="rounded-full border border-white/10 px-4 py-2 text-sm font-bold text-stone-200"
              >
                Sync
              </button>
            </div>

            <div className="mt-6 grid gap-5 lg:grid-cols-3">
              <WatchlistColumn
                title="Stocks"
                emptyText="Track AAPL, TSLA, NVDA, or another symbol."
                items={watchlist.stocks || []}
                onRemove={(item) => removeFromWatchlist('stock', item)}
              />
              <WatchlistColumn
                title="Crypto"
                emptyText="Add Bitcoin, Ethereum, Solana, or other coins."
                items={watchlist.crypto || []}
                onRemove={(item) => removeFromWatchlist('crypto', item)}
              />
              <WatchlistColumn
                title="Saved news"
                emptyText="Save articles from the news feed."
                items={watchlist.savedNews || []}
                onRemove={(item) => removeFromWatchlist('news', item)}
              />
            </div>
          </section>
        )}

        <footer className="pb-8 pt-2 text-center text-xs leading-6 text-stone-500">
          Data sources: Alpha Vantage, NewsAPI, CoinGecko, and Google Gemini when keys are configured. This app is informational only and does not provide financial advice.
        </footer>
      </div>
    </main>
  );
}

function WatchlistColumn({ title, emptyText, items, onRemove }) {
  return (
    <div className="rounded-[1.5rem] border border-white/10 bg-black/20 p-4">
      <h3 className="text-xl font-black">{title}</h3>
      <div className="mt-4 grid gap-3">
        {items.length === 0 && (
          <p className="rounded-2xl border border-dashed border-white/10 p-4 text-sm leading-6 text-stone-400">
            {emptyText}
          </p>
        )}
        {items.map((item) => (
          <div
            key={item.id || item.symbol || item.name}
            className="rounded-2xl border border-white/10 bg-white/[0.04] p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-black">{item.name || item.symbol}</p>
                <p className="text-xs text-stone-400">{item.symbol || item.url}</p>
                {item.price > 0 && (
                  <p className="mt-1 text-sm font-bold text-emerald-200">{formatCurrency(item.price)}</p>
                )}
              </div>
              <button
                onClick={() => onRemove(item)}
                className="rounded-full border border-white/10 px-3 py-1 text-xs font-bold text-stone-300"
              >
                Remove
              </button>
            </div>
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex text-sm font-bold text-amber-200"
              >
                Open saved story
              </a>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
