const express = require("express");
const axios = require("axios");

const router = express.Router();
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";
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

function fallbackAnswer(text, type = "general") {
  const topic = cleanText(text, 220) || "this market topic";
  const disclaimer =
    "This is informational only, not financial advice. Check current data and your own risk before investing.";

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

async function askGemini(prompt, maxOutputTokens = 450) {
  if (!hasGeminiKey()) {
    const error = new Error("Gemini API key is not configured");
    error.code = "NO_GEMINI_KEY";
    throw error;
  }

  const response = await axios.post(
    GEMINI_URL,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.45,
        topP: 0.9,
        maxOutputTokens
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

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error("Gemini returned an empty response");
  }

  return text.trim();
}

function buildPrompt(text, type) {
  const safeText = cleanText(text);
  const sharedInstruction =
    "Explain in plain language for a beginner. Be concise. Do not give personalized financial advice. Include a short informational disclaimer when investing is discussed.";

  const prompts = {
    "stock-movement": `You are a market explainer. ${sharedInstruction}\n\nQuestion or data: ${safeText}`,
    "crypto-trend": `You are a crypto market explainer. ${sharedInstruction}\n\nQuestion or data: ${safeText}`,
    "investment-question": `You are a financial education assistant. ${sharedInstruction}\n\nQuestion: ${safeText}`,
    "market-news": `You are a financial news analyst. ${sharedInstruction}\n\nNews: ${safeText}`,
    "chart-explanation": `You are explaining a market chart to a beginner. ${sharedInstruction}\n\nChart data or question: ${safeText}`,
    general: `You are NexTrade, a smart live market and news assistant. ${sharedInstruction}\n\nUser question: ${safeText}`
  };

  return prompts[type] || prompts.general;
}

router.post("/explain", async (req, res) => {
  const body = req.body || {};
  const text = cleanText(body.text);
  const type = normalizeExplanationType(body.type);

  if (!text) {
    return res.status(400).json({ error: "Text is required" });
  }

  try {
    const explanation = await askGemini(buildPrompt(text, type), 500);
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
      explanation: fallbackAnswer(text, type),
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

  const prompt = `Summarize this market or business article in 2-3 beginner-friendly sentences. Focus on what changed, who is affected, and why it matters. Do not give trading advice.\n\n${articleText}`;

  try {
    const summary = await askGemini(prompt, 220);
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
  const prompt = `Give a simple 3 sentence market summary for a dashboard using this data. Mention stocks, crypto, and news if present. Avoid financial advice.\n\n${safeMarketData}`;

  try {
    const insight = await askGemini(prompt, 260);
    return res.json({
      success: true,
      insight,
      status: "gemini",
      attribution: `Powered by Google Gemini (${GEMINI_MODEL})`
    });
  } catch (err) {
    return res.json({
      success: true,
      insight: "A live AI market summary is unavailable. Review the provider-labeled stock, crypto, and news data shown on the dashboard before drawing conclusions. This is informational only, not financial advice.",
      status: "fallback",
      message: geminiStatusMessage(err)
    });
  }
});

module.exports = router;
