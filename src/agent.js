const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/** ברירת מחדל: gemini-2.5-flash — תואם לרוב מכסות ה-Free ב-AI Studio; ניתן לדריסה ב-.env */
const GEMINI_MODEL =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** מושך מהודעת השגיאה את זמן ההמתנה שהשרת מציע (למשל "Please retry in 43.9s") */
function parseRetryDelayMs(err) {
  const msg = String(err?.message ?? err ?? "");
  const m = msg.match(/retry in ([\d.]+)\s*s/i);
  if (!m) return null;
  const sec = parseFloat(m[1]);
  if (Number.isNaN(sec)) return null;
  return Math.min(120_000, Math.ceil(sec * 1000) + 400);
}

function isTransientGeminiError(err) {
  const status = err?.status ?? err?.statusCode ?? err?.cause?.status;
  if (status === 429 || status === 503 || status === 502) return true;
  const msg = String(err?.message ?? err ?? "");
  return /429|503|502|Too Many Requests|quota|rate limit|unavailable|high demand/i.test(
    msg
  );
}

// טוען את בסיס הידע פעם אחת בהפעלה
const knowledgeBase = fs.readFileSync(
  path.join(__dirname, "knowledge.md"),
  "utf-8"
);

const SYSTEM_PROMPT = `אתה נציג מכירות של Tori — פלטפורמה שבונה אפליקציות ממותגות לעסקים קטנים.
הלקוח שמולך השאיר פרטים בדף הנחיתה שלנו ומתעניין בשירות.
המטרה שלך: לענות על שאלות, לבנות אמון, ולהוביל אותו להחלטת רכישה.

**הנחיות סגנון:**
- כתוב בעברית בלבד
- טון חם, אנושי, מקצועי — לא רובוטי
- הודעות קצרות מאוד — משפט עד שניים בלבד, כמו שיחת וואטסאפ אמיתית.
אל תשתמש בכוכביות (**) לעיצוב טקסט — זה נראה רע בוואטסאפ.
אל תרשום רשימות עם נקודות — שלב את המידע במשפט אחד טבעי.
אל תחזור על מידע שכבר אמרת באותה שיחה.
- שאל שאלה אחת בסוף כל הודעה כדי לשמור על השיחה
- אל תציג את כל המידע בבת אחת — תן מידע בהדרגה לפי מה שהלקוח שואל
- כשמתאים — הדגש את היתרון הגדול: "האפליקציה שלך, עם הלוגו שלך, לא של אף פלטפורמה"
- כשהלקוח מוכן — הצע לו לבחור מסלול ושאל מה מתאים לו יותר
- אם שאלה חורגת ממה שאתה יודע (כמו "יש ניסיון חינם?") — אמור שאתה בודק ומחזיר תשובה, ואל תמציא

**בסיס הידע שלך (השתמש רק במידע הזה):**
---
${knowledgeBase}
---

**אל תמציא מידע שאינו בבסיס הידע.**`;

const model = genAI.getGenerativeModel({
  model: GEMINI_MODEL,
  systemInstruction: SYSTEM_PROMPT,
});

// מאגר שיחות בזיכרון — { phone: [ { role: "user"|"model", parts: [{ text }] } ] }
const conversations = new Map();

/** Gemini דורש שהיסטוריה תתחיל ב-role "user" — קוצץ הודעות "model" מההתחלה */
function historyStartingWithUser(history) {
  let i = 0;
  while (i < history.length && history[i].role !== "user") i++;
  return history.slice(i);
}

async function getReply(phone, incomingText) {
  if (!conversations.has(phone)) {
    conversations.set(phone, []);
  }

  const history = conversations.get(phone);
  const histForChat = historyStartingWithUser(history);

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const chat = model.startChat({ history: histForChat });
    try {
      const result = await chat.sendMessage(incomingText);
      const reply = result.response.text();

      history.push(
        { role: "user", parts: [{ text: incomingText }] },
        { role: "model", parts: [{ text: reply }] }
      );

      if (history.length > 20) {
        conversations.set(phone, history.slice(-20));
      }

      return reply;
    } catch (err) {
      lastErr = err;
      if (!isTransientGeminiError(err) || attempt === maxAttempts - 1) {
        throw err;
      }
      let delayMs = parseRetryDelayMs(err);
      if (delayMs == null) {
        delayMs = Math.min(60_000, 4000 * (attempt + 1));
      }
      console.warn(
        `⚠️ Gemini זמני לא זמין — ממתין ${Math.round(delayMs / 1000)}s, ניסיון ${attempt + 2}/${maxAttempts}`
      );
      await sleep(delayMs);
    }
  }

  throw lastErr;
}

// הודעת פתיחה — נשלחת כשמתחילים שיחה יזומה (outbound)
function getOpeningMessage(name) {
  const firstName = name ? name.split(" ")[0] : "";
  return `שלום${firstName ? " " + firstName : ""}! 👋
ראינו שהשארת פרטים לגבי אפליקציה עם מיתוג אישי לעסק שלך.
אני כאן כדי לענות על כל שאלה ולעזור לך להבין אם Tori מתאימה לך 😊

באיזה תחום העסק שלך פועל?`;
}

module.exports = { getReply, getOpeningMessage, conversations };
