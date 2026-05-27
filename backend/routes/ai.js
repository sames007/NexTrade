const express = require("express");
const axios = require("axios");

const router = express.Router();
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const ALLOWED_EXPLANATION_TYPES = new Set([
  "stock-movement",
  "crypto-trend",
  "investment-question",
  "market-news",
  "chart-explanation",
  "general"
]);

function normalizeModelName(value) {
  const modelName = String(value || DEFAULT_GEMINI_MODEL)
    .trim()
    .replace(/^models\//, "")
    .replace(/[^a-zA-Z0-9_.-]/g, "")
    .slice(0, 80);

  return modelName || DEFAULT_GEMINI_MODEL;
}

const GEMINI_MODEL = normalizeModelName(process.env.GEMINI_MODEL);
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const requestConfig = {
  proxy: false,
  timeout: 20000
};

function getGeminiKey() {
  return String(process.env.GEMINI_API_KEY || "").trim();
}

function hasGeminiKey() {
  return Boolean(getGeminiKey());
}

function getThinkingConfig() {
  if (/^gemini-2\.5-/i.test(GEMINI_MODEL)) {
    return { thinkingBudget: 0 };
  }

  if (/^gemini-(3|flash-latest)/i.test(GEMINI_MODEL)) {
    return { thinkingLevel: "minimal" };
  }

  return null;
}

function cleanText(value, maxLength = 5000) {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeExplanationType(value) {
  const type = cleanText(value || "general", 40);
  return ALLOWED_EXPLANATION_TYPES.has(type) ? type : "general";
}

function formatContextPrice(value) {
  const price = Number(value);
  if (!Number.isFinite(price)) return "";
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: price < 1 ? 6 : 2 })}`;
}

function formatContextPercent(value) {
  const percent = Number(value);
  if (!Number.isFinite(percent)) return "";
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function contextualFallback(marketData = {}) {
  const points = [];
  const stock = marketData.stock;
  const crypto = Array.isArray(marketData.crypto) ? marketData.crypto[0] : null;
  const headlines = Array.isArray(marketData.headlines) ? marketData.headlines : [];

  if (stock?.symbol && Number.isFinite(Number(stock.latestPrice))) {
    const stockMove = formatContextPercent(stock.dailyChangePercent);
    const volume = Number(stock.volume);
    points.push(
      `${cleanText(stock.symbol, 12)} is ${formatContextPrice(stock.latestPrice)}${stockMove ? ` (${stockMove} today)` : ""}${Number.isFinite(volume) ? ` on volume of ${volume.toLocaleString("en-US")}` : ""}.`
    );
  }

  if (crypto?.symbol && Number.isFinite(Number(crypto.price))) {
    const cryptoMove = formatContextPercent(crypto.change);
    points.push(
      `${cleanText(crypto.symbol, 12)} is ${formatContextPrice(crypto.price)}${cryptoMove ? ` (${cryptoMove} over 24 hours)` : ""}.`
    );
  }

  if (headlines[0]) {
    points.push(`A displayed headline is "${cleanText(headlines[0], 140)}".`);
  }

  if (!points.length) return "";

  return `${points.join(" ")} This summary uses only currently displayed provider data because Gemini is unavailable.`;
}

function fallbackAnswer(text, type = "general", marketData = {}) {
  const topic = cleanText(text, 220) || "this market topic";
  const disclaimer =
    "This is informational only, not financial advice. Check current data and your own risk before investing.";
  const liveContext = contextualFallback(marketData);

  if (liveContext) {
    return `${liveContext} ${disclaimer}`;
  }

  if (type === "crypto-trend") {
    return `In simple terms, crypto prices often move because of risk appetite, liquidity, regulation news, and large trader activity. For "${topic}", compare price action with volume, Bitcoin trend, and recent headlines. ${disclaimer}`;
  }

  if (type === "stock-movement") {
    return `A stock usually moves because investors are reacting to earnings, guidance, rates, product news, or broader market sentiment. For "${topic}", look for the latest headline and whether volume confirms the move. ${disclaimer}`;
  }

  if (type === "market-news") {
    return `The key thing to ask is whether this news changes expected growth, costs, regulation, or investor confidence. For "${topic}", focus on what changed today versus what the market already expected. ${disclaimer}`;
  }

  return `Here is the simple version: "${topic}" should be read through price trend, news context, volume, and risk. ${disclaimer}`;
}

function geminiStatusMessage(err) {
  if (err?.code === "NO_GEMINI_KEY") {
    return "Gemini API key is missing";
  }

  const providerMessage = err?.response?.data?.error?.message || "";
  if (/api key not valid/i.test(providerMessage)) {
    return "Gemini API key is invalid";
  }

  if (/not found/i.test(providerMessage)) {
    return `Gemini model ${GEMINI_MODEL} was not found`;
  }

  return "Gemini unavailable; returned local fallback";
}

async function generateGeminiContent(prompt, maxOutputTokens) {
  const thinkingConfig = getThinkingConfig();

  return axios.post(
    GEMINI_URL,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.45,
        topP: 0.9,
        maxOutputTokens,
        ...(thinkingConfig ? { thinkingConfig } : {})
      }
    },
    {
      ...requestConfig,
      headers: {
        "Content-Type": "application/json",
        "X-goog-api-key": getGeminiKey()
      }
    }
  );
}

function getGeminiText(response) {
  return (response.data?.candidates?.[0]?.content?.parts || [])
    .map((part) => part.text || "")
    .join("")
    .trim();
}

async function askGemini(prompt, maxOutputTokens = 700) {
  if (!hasGeminiKey()) {
    const error = new Error("Gemini API key is not configured");
    error.code = "NO_GEMINI_KEY";
    throw error;
  }

  let response = await generateGeminiContent(prompt, maxOutputTokens);
  if (response.data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    response = await generateGeminiContent(prompt, Math.max(maxOutputTokens * 2, 1600));
  }

  const text = getGeminiText(response);
  if (!text || response.data?.candidates?.[0]?.finishReason === "MAX_TOKENS") {
    throw new Error("Gemini returned an empty response");
  }

  return text;
}

function buildPrompt(text, type, marketData = {}) {
  const safeText = cleanText(text);
  const safeMarketData = JSON.stringify(marketData).slice(0, 4000);
  const sharedInstruction =
    "Explain in plain language for a beginner in no more than four short sentences. Use plain text only, without Markdown headings or bullets. Do not give personalized financial advice. Include a short informational disclaimer when investing is discussed.";
  const liveContext =
    safeMarketData !== "{}"
      ? `\n\nCurrent provider-sourced dashboard data. Use it when relevant and do not invent missing live facts. Treat prices as displayed/latest values, not closing prices, unless the data explicitly says otherwise:\n${safeMarketData}`
      : "";

  const prompts = {
    "stock-movement": `You are a market explainer. ${sharedInstruction}\n\nQuestion or data: ${safeText}${liveContext}`,
    "crypto-trend": `You are a crypto market explainer. ${sharedInstruction}\n\nQuestion or data: ${safeText}${liveContext}`,
    "investment-question": `You are a financial education assistant. ${sharedInstruction}\n\nQuestion: ${safeText}${liveContext}`,
    "market-news": `You are a financial news analyst. ${sharedInstruction}\n\nNews: ${safeText}${liveContext}`,
    "chart-explanation": `You are explaining a market chart to a beginner. ${sharedInstruction}\n\nChart data or question: ${safeText}${liveContext}`,
    general: `You are NexTrade, a smart live market and news assistant. ${sharedInstruction}\n\nUser question: ${safeText}${liveContext}`
  };

  return prompts[type] || prompts.general;
}

router.post("/explain", async (req, res) => {
  const body = req.body || {};
  const text = cleanText(body.text);
  const type = normalizeExplanationType(body.type);
  const marketData =
    body.marketData && typeof body.marketData === "object" ? body.marketData : {};

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    const explanation = await askGemini(buildPrompt(text, type, marketData), 900);
    return res.json({
      success: true,
      explanation,
      type,
      status: "gemini",
      attribution: `Powered by Google Gemini (${GEMINI_MODEL})`
    });
  } catch (err) {
    return res.json({
      success: true,
      explanation: fallbackAnswer(text, type, marketData),
      type,
      status: "fallback",
      message: geminiStatusMessage(err)
    });
  }
});

router.post("/summarize-news", async (req, res) => {
  const body = req.body || {};
  const title = cleanText(body.title, 500);
  const description = cleanText(body.description, 1500);
  const content = cleanText(body.content, 2500);
  const articleText = [title, description, content].filter(Boolean).join("\n");

  if (!articleText) {
    return res.status(400).json({ error: "Article content is required" });
  }

  const prompt = `Summarize this market or business article in 2-3 beginner-friendly plain-text sentences without Markdown. Focus on what changed, who is affected, and why it matters. Do not give trading advice.\n\n${articleText}`;

  try {
    const summary = await askGemini(prompt, 600);
    return res.json({
      success: true,
      summary,
      status: "gemini",
      attribution: `Summarized by Google Gemini (${GEMINI_MODEL})`
    });
  } catch (err) {
    return res.json({
      success: true,
      summary: `${title || "This article"} appears important because it may affect market expectations. Read the full story for details before making any investing decision.`,
      status: "fallback",
      message: geminiStatusMessage(err)
    });
  }
});

router.post("/market-insight", async (req, res) => {
  const body = req.body || {};
  const marketData =
    body.marketData && typeof body.marketData === "object" ? body.marketData : {};
  const safeMarketData = JSON.stringify(marketData).slice(0, 4000);
  const prompt = `Give a simple 3 sentence plain-text market summary for a dashboard using this data. Mention stocks, crypto, and news if present. Treat prices as displayed/latest values, not closing prices, unless provided. Avoid financial advice.\n\n${safeMarketData}`;

  try {
    const insight = await askGemini(prompt, 700);
    return res.json({
      success: true,
      insight,
      status: "gemini",
      attribution: `Powered by Google Gemini (${GEMINI_MODEL})`
    });
  } catch (err) {
    const fallbackInsight = contextualFallback(marketData);
    return res.json({
      success: true,
      insight: fallbackInsight
        ? `${fallbackInsight} This is informational only, not financial advice.`
        : "A live AI market summary is unavailable. Review the provider-labeled stock, crypto, and news data shown on the dashboard before drawing conclusions. This is informational only, not financial advice.",
      status: "fallback",
      message: geminiStatusMessage(err)
    });
  }
});

module.exports = router;
