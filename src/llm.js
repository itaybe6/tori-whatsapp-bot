const { GoogleGenerativeAI } = require("@google/generative-ai");

const DEFAULT_GEMINI_MODEL =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";
const DEFAULT_OPENAI_MODEL =
  process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";

const DEFAULT_TEMPERATURE = Number(process.env.AI_TEMPERATURE) || 0.5;

const GEMINI_GENERATION_DEFAULTS = {
  maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 256,
  temperature: DEFAULT_TEMPERATURE,
  thinkingConfig: { thinkingBudget: 0 },
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveProvider() {
  const explicit = String(process.env.AI_PROVIDER || "").trim().toLowerCase();
  if (explicit === "openai" || explicit === "gemini") return explicit;
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  return "gemini";
}

function getProviderLabel() {
  return resolveProvider() === "openai" ? "OpenAI" : "Gemini";
}

function parseRetryDelayMs(err) {
  const msg = String(err?.message ?? err ?? "");
  const m = msg.match(/retry in ([\d.]+)\s*s/i);
  if (!m) return null;
  const sec = parseFloat(m[1]);
  if (Number.isNaN(sec)) return null;
  return Math.min(120_000, Math.ceil(sec * 1000) + 400);
}

function isTransientError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.cause?.status;
  if (status === 429 || status === 503 || status === 502) return true;
  const msg = String(err?.message ?? err ?? "");
  return /429|503|502|Too Many Requests|quota|rate limit|unavailable|high demand/i.test(
    msg
  );
}

function isQuotaError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.cause?.status;
  if (status === 429) return true;
  return /quota exceeded|Too Many Requests|429|rate limit/i.test(
    String(err?.message ?? err ?? "")
  );
}

function isInvalidKeyError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.cause?.status;
  if (status === 401 || status === 403) return true;
  const msg = String(err?.message ?? err ?? "");
  return /API_KEY_INVALID|invalid api key|incorrect api key|authentication/i.test(
    msg
  );
}

function formatAIUserError(err) {
  const provider = getProviderLabel();
  if (isInvalidKeyError(err)) {
    if (resolveProvider() === "openai") {
      return (
        "מפתח OpenAI לא תקין. ודא ש-OPENAI_API_KEY ב-.env נכון, " +
        "ש-AI_PROVIDER=openai, והפעל מחדש npm start."
      );
    }
    return (
      "מפתח Gemini לא תקין. אם עברת ל-ChatGPT — הגדר AI_PROVIDER=openai ו-OPENAI_API_KEY ב-.env. " +
      "אם משתמש ב-Gemini — ודא ש-GEMINI_API_KEY תקין."
    );
  }
  if (isQuotaError(err)) {
    if (resolveProvider() === "openai") {
      return (
        "מכסת OpenAI API מלאה או הגבלת קצב. נסה שוב בעוד כדקה או בדוק Billing ב-OpenAI."
      );
    }
    return (
      "מכסת Gemini API מלאה (תוכנית חינמית: בערך 20 בקשות ליום לדגם gemini-2.5-flash). " +
      "נסה שוב בעוד כדקה, שדרג חשבון ב-Google AI Studio, או עבר ל-OpenAI עם AI_PROVIDER=openai."
    );
  }
  return err?.message || String(err);
}

function geminiHistoryToOpenAIMessages(systemInstruction, history, userMessage) {
  const messages = [{ role: "system", content: systemInstruction }];
  for (const h of history) {
    const text = h.parts?.[0]?.text ?? h.content ?? "";
    messages.push({
      role: h.role === "model" ? "assistant" : "user",
      content: String(text),
    });
  }
  if (userMessage) {
    messages.push({ role: "user", content: String(userMessage) });
  }
  return messages;
}

function safeGeminiText(result) {
  try {
    return String(result?.response?.text?.() || "").trim();
  } catch (_err) {
    return "";
  }
}

async function openaiChatCompletion(messages, options = {}) {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    throw new Error("חסר OPENAI_API_KEY ב-.env");
  }

  const model = options.model || DEFAULT_OPENAI_MODEL;
  const body = {
    model,
    messages,
    max_tokens: options.maxOutputTokens ?? 256,
    temperature: options.temperature ?? DEFAULT_TEMPERATURE,
  };
  if (options.jsonMode) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      data?.error?.message ||
      `OpenAI API error ${res.status}: ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }

  return String(data?.choices?.[0]?.message?.content || "").trim();
}

async function geminiGenerateContent(systemInstruction, userPrompt, options = {}) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error("חסר GEMINI_API_KEY ב-.env");
  }

  const genAI = new GoogleGenerativeAI(key);
  const generationConfig = {
    ...GEMINI_GENERATION_DEFAULTS,
    maxOutputTokens: options.maxOutputTokens ?? GEMINI_GENERATION_DEFAULTS.maxOutputTokens,
    temperature: options.temperature ?? GEMINI_GENERATION_DEFAULTS.temperature,
  };
  if (options.jsonMode) {
    generationConfig.responseMimeType = "application/json";
  }

  const model = genAI.getGenerativeModel({
    model: options.model || DEFAULT_GEMINI_MODEL,
    systemInstruction,
    generationConfig,
  });

  const result = await model.generateContent(userPrompt);
  return safeGeminiText(result);
}

async function geminiChat(systemInstruction, history, userMessage, options = {}) {
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) {
    throw new Error("חסר GEMINI_API_KEY ב-.env");
  }

  const genAI = new GoogleGenerativeAI(key);
  const generationConfig = {
    ...GEMINI_GENERATION_DEFAULTS,
    maxOutputTokens: options.maxOutputTokens ?? GEMINI_GENERATION_DEFAULTS.maxOutputTokens,
    temperature: options.temperature ?? GEMINI_GENERATION_DEFAULTS.temperature,
  };

  const model = genAI.getGenerativeModel({
    model: options.model || DEFAULT_GEMINI_MODEL,
    systemInstruction,
    generationConfig,
  });

  const chat = model.startChat({ history });
  const result = await chat.sendMessage(userMessage);
  return safeGeminiText(result);
}

async function withTransientRetry(fn, label, maxAttempts = 5) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      let delayMs = parseRetryDelayMs(err);
      if (delayMs == null) {
        delayMs = Math.min(60_000, 4000 * (attempt + 1));
      }
      console.warn(
        `⚠️ ${label} — ממתין ${Math.round(delayMs / 1000)}s, ניסיון ${attempt + 2}/${maxAttempts}`
      );
      await sleep(delayMs);
    }
  }
  if (lastErr) throw lastErr;
  throw new Error(`שגיאת ${label}`);
}

async function completeText({
  systemInstruction = "",
  userPrompt,
  temperature,
  maxOutputTokens,
  jsonMode = false,
  maxAttempts = 5,
}) {
  const provider = resolveProvider();
  const label = `${getProviderLabel()} (generate)`;

  return withTransientRetry(async () => {
    if (provider === "openai") {
      const messages = [
        { role: "system", content: systemInstruction },
        { role: "user", content: userPrompt },
      ];
      return await openaiChatCompletion(messages, {
        temperature,
        maxOutputTokens,
        jsonMode,
      });
    }
    return await geminiGenerateContent(systemInstruction, userPrompt, {
      temperature,
      maxOutputTokens,
      jsonMode,
    });
  }, label, maxAttempts);
}

async function chatText({
  systemInstruction,
  history,
  userMessage,
  temperature,
  maxOutputTokens,
  maxAttempts = 5,
}) {
  const provider = resolveProvider();
  const label = `${getProviderLabel()} (chat)`;

  return withTransientRetry(async () => {
    if (provider === "openai") {
      const messages = geminiHistoryToOpenAIMessages(
        systemInstruction,
        history,
        userMessage
      );
      return await openaiChatCompletion(messages, {
        temperature,
        maxOutputTokens,
      });
    }
    return await geminiChat(systemInstruction, history, userMessage, {
      temperature,
      maxOutputTokens,
    });
  }, label, maxAttempts);
}

async function completeJson({ userPrompt, maxOutputTokens = 8192, maxAttempts = 3 }) {
  const jsonPrompt =
    userPrompt +
    "\n\nהחזר תשובה בפורמט JSON תקין בלבד (בלי markdown).";

  const text = await completeText({
    systemInstruction:
      "You return valid JSON only. No markdown fences, no commentary.",
    userPrompt: jsonPrompt,
    temperature: 0.35,
    maxOutputTokens,
    jsonMode: resolveProvider() === "openai",
    maxAttempts,
  });
  return text;
}

module.exports = {
  resolveProvider,
  getProviderLabel,
  completeText,
  chatText,
  completeJson,
  isTransientError,
  isQuotaError,
  isInvalidKeyError,
  formatAIUserError,
  parseRetryDelayMs,
  sleep,
};
