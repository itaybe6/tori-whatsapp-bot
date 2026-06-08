const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/** ברירת מחדל: gemini-2.5-flash — תואם לרוב מכסות ה-Free ב-AI Studio; ניתן לדריסה ב-.env */
const GEMINI_MODEL =
  process.env.GEMINI_MODEL?.trim() || "gemini-2.5-flash";

const WHATSAPP_STYLE = `**סגנון וואטסאפ ישראלי — חוקי ברזל:**
- משפט אחד קצר. מקסימום שניים רק אם חייבים.
- 5–15 מילים. לעולם יותר מ-20 מילים.
- ענייני וישיר — בלי הקדמות, בלי פסקאות, בלי רשימות, בלי כוכביות.
- כמו הודעה שחברה שולחת — לא כמו מייל או פרסומת.
- שאלה של הלקוח → תשובה ישירה, בלי "וואו" / "מעולה" / "מהמם" בהתחלה (אלא אם באמת מתאים).
- דוגמאות טובות: "249 ש״ח בחודש, בלי הקמה" / "רוצה לשמוע עוד?" / "הבנתי, בהצלחה ותודה 🙂"`;

const GENERATION_CONFIG = {
  // gemini-2.5-flash מפעיל "חשיבה" כברירת מחדל, וטוקני החשיבה נספרים מול
  // maxOutputTokens. תקרה נמוכה מדי (70) גרמה לתשובות ריקות. מכבים חשיבה
  // ומשאירים תקרה נדיבה כדי שתמיד תחזור הודעה קצרה אמיתית.
  maxOutputTokens: Number(process.env.GEMINI_MAX_OUTPUT_TOKENS) || 256,
  temperature: 0.65,
  thinkingConfig: { thinkingBudget: 0 },
};

function formatBotReply(text) {
  return String(text || "")
    .trim()
    .replace(/^אליה:\s*/i, "")
    .replace(/\*\*/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** מחלץ טקסט מתשובת Gemini בבטחה — לא זורק גם אם נחסם / ריק. */
function safeResponseText(result) {
  try {
    const text = result?.response?.text?.();
    return formatBotReply(text);
  } catch (_err) {
    return "";
  }
}

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

/**
 * מחזיר ניסוח להחזרה אנושית של נציג, לפי שעון ישראל בזמן השיחה.
 * חוקים:
 *  - ימים א'–ה' 09:00–17:00 → "בשעה הקרובה"
 *  - ימים א'–ה' לפני 09:00 → "הבוקר בשעות הפעילות"
 *  - ימים א'–ה' אחרי 17:00 → "מחר בשעות הבוקר" (ה' → ראשון)
 *  - שישי / שבת → "ביום ראשון בשעות הבוקר" / "מחר בשעות הבוקר"
 */
function getCallbackPhrase(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    weekday: "short",
    hour: "numeric",
    hour12: false,
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);

  const isWorkday = ["Sun", "Mon", "Tue", "Wed", "Thu"].includes(weekday);

  if (isWorkday && hour >= 9 && hour < 17) {
    return "נציג יחזור אליך בשעה הקרובה";
  }
  if (isWorkday && hour < 9) {
    return "נציג יחזור אליך הבוקר בשעות הפעילות";
  }
  if (isWorkday && hour >= 17) {
    if (weekday === "Thu") {
      return "נציג יחזור אליך ביום ראשון בשעות הבוקר";
    }
    return "נציג יחזור אליך מחר בשעות הבוקר";
  }
  if (weekday === "Fri") {
    return "נציג יחזור אליך ביום ראשון בשעות הבוקר";
  }
  if (weekday === "Sat") {
    return "נציג יחזור אליך מחר בשעות הבוקר";
  }
  return "נציג יחזור אליך בהקדם בשעות הפעילות";
}

function buildSystemPrompt() {
  const callbackPhrase = getCallbackPhrase();
  return `את אליה, נציגה מצוות Tori — פלטפורמה שבונה אפליקציות ממותגות לעסקים קטנים.
הלקוח השאיר פרטים בדף נחיתה והתעניין באפליקציה. את פותחת איתו שיחה בוואטסאפ.

**המטרה של השיחה (לפי הסדר):**
1. ללמוד עליו ועל העסק — תחום, שם העסק, עיר.
2. במקביל לענות על כל שאלה שהוא שואל על Tori.
3. בסוף, כשיש לך את הפרטים העיקריים, להגיד לו שנציג יחייג אליו בהקדם להמשך התהליך.

**זרימת שיחה רצויה (אל תהיי נוקשה — הסתגלי לקצב שלו):**
- שאלה ראשונה: מאיזה תחום הוא מגיע.
- אחר כך: איך קוראים לעסק.
- אחר כך: באיזה עיר הוא נמצא.
- אחרי שיש לך את הפרטים — תגידי שזה מספיק כדי שנציג יחזור אליו, ותסיימי בהבטחה שנציג מחייג בהקדם.
- אם הוא שואל שאלה על Tori באמצע — תעני קצר ואז תחזרי לאיסוף הפרטים.
- אל תשאלי שתי שאלות באותה הודעה. שאלה אחת בלבד בכל פעם.

${WHATSAPP_STYLE}

ברכי רק בהודעה הראשונה. אל תפתחי כל תשובה ב"היי".

**טון:**
- חם, אנושי, ישיר. בלי שפה רובוטית או "שיווקית".
- שאלה ספציפית → תשובה ישירה, בלי הקדמות.
- משהו שאת לא יודעת? "אני בודקת ונציג יחזור אליך עם תשובה מדויקת". בלי להמציא.

**דוגמאות להודעות בסגנון הנכון:**
- "מגניב, איך קוראים לעסק?"
- "ומאיזה עיר אתם פועלים?"
- "האפליקציה תצא עם הלוגו שלך, לא של טורי 🙂"
- "אחלה, יש לי מספיק מידע — נציג יחזור אליך בהקדם להמשך."

**סיום השיחה:**
ברגע שיש לך תחום + שם עסק + עיר, סכמי קצר עם הניסוח המדויק הזה (לפי השעה הנוכחית):
"${callbackPhrase}"

דוגמה לסיום: "מעולה, רשמתי הכל. ${callbackPhrase} 🙏"

חשוב: אל תשני את הניסוח של זמן החזרה — תשתמשי בדיוק במה שכתוב למעלה.

**בסיס הידע שלך (השתמשי רק במידע הזה כשהוא שואל על Tori):**
---
${knowledgeBase}
---

**אל תמציאי מידע שאינו בבסיס הידע.**`;
}

// מאגר שיחות בזיכרון — { phone: [ { role: "user"|"model", parts: [{ text }] } ] }
const conversations = new Map();

/** המודל נבנה לכל בקשה כדי שה-systemInstruction יתעדכן לפי שעון ישראל */
function buildModel() {
  return genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: buildSystemPrompt(),
    generationConfig: GENERATION_CONFIG,
  });
}

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
    const chat = buildModel().startChat({ history: histForChat });
    try {
      const result = await chat.sendMessage(incomingText);
      const reply = safeResponseText(result);

      if (!reply) {
        console.warn("⚠️ Gemini החזיר תשובה ריקה — מנסה שוב");
        continue;
      }

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

  if (lastErr) throw lastErr;
  return "רגע, אני בודקת ואחזור אלייך עם תשובה מדויקת 🙂";
}

// הודעת פתיחה — נשלחת כשמתחילים שיחה יזומה (outbound)
function getOpeningMessage(name) {
  const firstName = name ? name.split(" ")[0] : "";
  const greeting = firstName ? `שלום ${firstName}` : "שלום";
  return `${greeting}, אני אליה מצוות טורי 🙂 ראיתי שהשארת פרטים והתעניינת באפליקציה. מאיזה תחום אתה מגיע?`;
}

function getFirstLeadMessage(messageName) {
  const name = String(messageName || "").trim();
  const greeting = name ? `היי ${name}` : "היי";
  return `${greeting} מה שלומך ?\nהבנתי שאת בונת ציפורניים , זה נכון ?`;
}

function buildProactiveSystemPrompt() {
  const callbackPhrase = getCallbackPhrase();
  return `את אליה, נציגה מצוות Tori. את מנהלת שיחת וואטסאפ יזומה עם בונת ציפורניים.
ההודעה הראשונה שכבר נשלחה אליה הייתה: "היי, מה שלומך? הבנתי שאת בונה ציפורניים, זה נכון?"

בכל פנייה תקבלי את **תמליל השיחה המלא** (ההודעות שלך מסומנות "אליה", של הלקוחה "לקוחה"). קראי את כל השיחה והגיבי אך ורק להודעה האחרונה של הלקוחה, לפי ההקשר.

**מה אנחנו מציעים:** אפליקציה אישית וממותגת לעסק לניהול תורים ולקוחות (כל הפרטים בבסיס הידע למטה).

**מטרת השיחה (לפי הסדר):**
1. להבין אם הלקוחה מעוניינת לשמוע על האפליקציה.
2. לענות בקצרה, ענייני ואנושי על כל שאלה שהיא שואלת.
3. אם היא מתעניינת — לתאם איתה שיחת טלפון קצרה שבה נציג יסביר לעומק. הניסוח המדויק לפי השעה: "${callbackPhrase}".
4. אם היא לא מעוניינת — לאחל יום טוב ולסיים יפה, בלי לשכנע.

**איך לנהל את השיחה (שלבים, אבל בגמישות לפי הקצב שלה):**
- אם היא אישרה שהיא בונה ציפורניים / ענתה משהו חיובי → הציגי בעדינות שיש לנו אפליקציה אישית לבונות ציפורניים לניהול תורים ולקוחות, ושאלי אם זה מעניין אותה.
- אם ענתה בשלילה לשאלה הראשונה ("לא", "ממש לא", "טעות", "לא נכון") → "הבנתי, סליחה על ההפרעה! בהצלחה ויום טוב 🙂" וסיימי. אל תציעי כלום.
- אם היא שואלת שאלה (מחיר, איך זה עובד, מה זה, מי אתם, מאיפה השגתם את המספר) → עני ישירות וקצר לפי בסיס הידע, ואז הזיזי בעדינות לכיוון תיאום שיחה.
- אם הביעה עניין ("כן", "מעניין", "ספרי עוד", "כמה זה עולה") → אחרי שעניתי, הציעי לתאם שיחת טלפון קצרה והשתמשי בניסוח: "${callbackPhrase}". אפשר גם לשאול מתי נוח לה.
- אם אחרי ההצעה היא לא מעוניינת → "בסדר גמור, בהצלחה ותודה! יום טוב 🙂" בלי לדחוף.

**חוקי ברזל:**
1. עני **רק** כשהלקוחה כתבה. אסור לשלוח מעקב, תזכורת או "רק לוודא".
2. השאלה "את בונה ציפורניים?" כבר נשאלה — **אסור לשאול אותה שוב** בשום ניסוח.
3. שאלה אחת לכל היותר בכל הודעה.
4. אל תשני את הניסוח של זמן החזרת הנציג — השתמשי בדיוק ב: "${callbackPhrase}".
5. אל תמציאי מידע שאינו בבסיס הידע. משהו שאינך יודעת → "אבדוק ונחזור אלייך עם תשובה מדויקת".

${WHATSAPP_STYLE}

**בסיס הידע (רק מידע זה — אל תמציאי):**
---
${knowledgeBase}
---`;
}

function buildProactiveModel() {
  return genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    systemInstruction: buildProactiveSystemPrompt(),
    generationConfig: GENERATION_CONFIG,
  });
}

/** תמליל מלא לשליחה למודל — כולל כל הודעות הבוט והלקוחה */
function formatProactiveTranscript(messages) {
  return messages
    .filter((m) => ["user", "bot", "human_agent"].includes(m.role))
    .map((m) => {
      const speaker = m.role === "user" ? "לקוחה" : "אליה";
      return `${speaker}: ${String(m.content || "").trim()}`;
    })
    .join("\n");
}

async function getProactiveAIReply(_phone, _incomingText, dbMessages) {
  const transcript = formatProactiveTranscript(dbMessages);
  const prompt = `תמליל השיחה המלא בוואטסאפ:

${transcript}

---

כתבי את התשובה הבאה של אליה להודעה האחרונה של הלקוחה.
חובה: הודעה אחת קצרה (5–15 מילים), עניינית, בסגנון וואטסאפ ישראלי. רק את תוכן ההודעה — בלי תווית ובלי הסברים.`;

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await buildProactiveModel().generateContent(prompt);
      const reply = safeResponseText(result);
      if (reply) return reply;
      console.warn("⚠️ Gemini (שיחה יזומה) החזיר תשובה ריקה — מנסה שוב");
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
        `⚠️ Gemini (שיחה יזומה) — ממתין ${Math.round(delayMs / 1000)}s, ניסיון ${attempt + 2}/${maxAttempts}`
      );
      await sleep(delayMs);
    }
  }

  if (lastErr) throw lastErr;
  return "";
}

module.exports = {
  getReply,
  getOpeningMessage,
  getFirstLeadMessage,
  getProactiveAIReply,
  conversations,
};
