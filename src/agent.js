const {
  getAiAgentConfig,
} = require("./aiAgentConfig");
const {
  DEFAULT_INBOUND_PROMPT,
  DEFAULT_OUTBOUND_PROMPT,
  DEFAULT_CONVERSATION_GUIDE,
} = require("./promptDefaults");
const {
  chatText,
  completeText,
  isQuotaError,
  formatAIUserError,
} = require("./llm");

function formatBotReply(text) {
  return String(text || "")
    .trim()
    .replace(/^אליה:\s*/i, "")
    .replace(/\*\*/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

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

function resolveInboundSystemPrompt(config) {
  const override = String(config.inbound?.systemPromptOverride || "").trim();
  if (override) return override;
  return buildInboundSystemPrompt(config);
}

function resolveOutboundSystemPrompt(config) {
  const override = String(config.outbound?.systemPromptOverride || "").trim();
  if (override) return override;
  return buildOutboundSystemPrompt(config);
}

/**
 * הפרומפט המלא = פרומפט ייחודי (נכנסות/יוצאות) + ניהול שיחה מכירתי + בסיס ידע.
 */
function buildInboundSystemPrompt(config) {
  const kb = config.knowledgeBase || "";
  const prompt = String(config.inbound?.prompt || DEFAULT_INBOUND_PROMPT).trim();
  const guide = String(
    config.inbound?.conversationGuide || DEFAULT_CONVERSATION_GUIDE
  ).trim();

  return `${prompt}

${guide}

**בסיס הידע הרשמי של Tori:**
---
${kb}
---`;
}

function buildOutboundSystemPrompt(config) {
  const kb = config.knowledgeBase || "";
  const prompt = String(config.outbound?.prompt || DEFAULT_OUTBOUND_PROMPT).trim();
  const guide = String(
    config.outbound?.conversationGuide || DEFAULT_CONVERSATION_GUIDE
  ).trim();

  return `${prompt}

${guide}

**בסיס הידע הרשמי של Tori:**
---
${kb}
---`;
}

const conversations = new Map();

const REVISION_QUESTION_PATTERNS = [
  /מאיזה תחום/iu,
  /מאיזו תחום/iu,
  /איך קוראים לעסק/iu,
  /שם העסק/iu,
  /מאיזה עיר/iu,
  /מאיזו עיר/iu,
  /באיזה עיר/iu,
  /באיזו עיר/iu,
];

function formatRevisionTranscript(priorMessages, agentName, wrongMessage) {
  const lines = [];
  for (const m of priorMessages) {
    if (m.role === "user") {
      lines.push(`לקוח: ${m.content}`);
    } else if (m.role === "bot") {
      lines.push(`${agentName}: ${m.content}`);
    }
  }
  lines.push(
    `${agentName} [הודעה שגויה שצריך להחליף — לא להשאיר כמו שהיא]: ${wrongMessage}`
  );
  return lines.join("\n");
}

function matchedQuestionPatterns(text) {
  const t = String(text || "");
  return REVISION_QUESTION_PATTERNS.filter((re) => re.test(t));
}

function revisedRepeatsPriorQuestion(revised, priorMessages) {
  const revisedPatterns = matchedQuestionPatterns(revised);
  if (!revisedPatterns.length) return false;
  for (const m of priorMessages) {
    if (m.role !== "bot") continue;
    const priorPatterns = matchedQuestionPatterns(m.content);
    for (const rp of revisedPatterns) {
      if (priorPatterns.some((pp) => pp.source === rp.source)) return true;
    }
  }
  return false;
}

function buildRevisionPrompt(
  agentName,
  transcript,
  original,
  note,
  mode,
  retryHint
) {
  const flowHint =
    mode === "inbound"
      ? "אם הלקוח כבר ענה על תחום — המשך לשאלה הבאה (שם עסק, עיר). אם כבר יש תחום+עסק — עיר. אל תחזור על שאלות מהתמליל."
      : "אל תחזור על שאלות שכבר נשאלו בתמליל. המשך לפי ההקשר וההערה.";

  return `אימון נציג AI — כתוב **הודעה מתוקנת אחת** של ${agentName} שמחליפה את ההודעה השגויה.

תמליל השיחה עד כה:
${transcript}

הודעת הנציג השגויה (להחליף — לא לשכפל):
"${original}"

הערת המאמן (חובה ליישם במלואה):
"${note}"

משימה:
- כתוב את ההודעה שאמורה להחליף את ההודעה השגויה **באותו נקודת זמן בשיחה**
- אסור לשאול שאלה שכבר נשאלה בתמליל למעלה
- אם הלקוח כבר ענה על משהו — אל תשאל שוב; המשך לשאלה הבאה
- ${flowHint}
- הודעה אחת מלאה, 5–20 מילים, וואטסאפ ישראלי, ענייני
- רק טקסט ההודעה — בלי תווית, בלי מרכאות, בלי הסברים
${retryHint ? `\n${retryHint}` : ""}`;
}

async function regenerateAgentReplyWithTrainerNote(
  mode,
  priorMessages,
  originalMessage,
  trainerNote,
  agentName = "אליה"
) {
  const note = String(trainerNote || "").trim();
  const original = String(originalMessage || "").trim();
  const name = String(agentName || "אליה").trim();
  const transcript = formatRevisionTranscript(priorMessages, name, original);

  const config = await getAiAgentConfig();
  const systemInstruction =
    mode === "inbound"
      ? resolveInboundSystemPrompt(config)
      : resolveOutboundSystemPrompt(config);

  let retryHint = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = buildRevisionPrompt(
      name,
      transcript,
      original,
      note,
      mode,
      retryHint
    );
    const raw = await completeText({
      systemInstruction,
      userPrompt: prompt,
      maxAttempts: 2,
    });
    const reply = formatBotReply(raw);
    if (!reply || reply.length < 4) {
      retryHint =
        "התשובה הקודמת ריקה או קצרה מדי. כתוב הודעה מלאה ושונה מההודעה השגויה.";
      continue;
    }
    if (reply === original) {
      retryHint =
        "התשובה זהה להודעה השגויה. כתוב משהו **שונה** שמיישם את ההערה.";
      continue;
    }
    if (revisedRepeatsPriorQuestion(reply, priorMessages)) {
      retryHint =
        "התשובה עדיין חזרה על שאלה שכבר נשאלה בשיחה. כתוב שאלה **אחרת** או תגובה שממשיכה הלאה בלי לשאול שוב.";
      continue;
    }
    return reply;
  }

  return ruleBasedRevisionFallback(priorMessages, original);
}

function ruleBasedRevisionFallback(priorMessages, wrongMessage) {
  const original = String(wrongMessage || "").trim();
  const hasUser = priorMessages.some((m) => m.role === "user");
  if (hasUser && /מאיזה תחום|מאיזו תחום/iu.test(original)) {
    return "מגניב! איך קוראים לעסק?";
  }
  if (hasUser && /איך קוראים לעסק|שם העסק/iu.test(original)) {
    return "אחלה, ומאיזה עיר אתה?";
  }
  return original;
}

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
  const config = await getAiAgentConfig();
  const systemInstruction = resolveInboundSystemPrompt(config);

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await chatText({
        systemInstruction,
        history: histForChat,
        userMessage: incomingText,
        maxAttempts: 1,
      });
      const reply = formatBotReply(raw);

      if (!reply) {
        console.warn("⚠️ המודל החזיר תשובה ריקה — מנסה שוב");
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
      if (attempt === maxAttempts - 1) throw err;
      console.warn(`⚠️ ניסיון ${attempt + 2}/${maxAttempts} אחרי שגיאה`);
    }
  }

  if (lastErr) throw lastErr;
  return "רגע, אני בודקת ואחזור אלייך עם תשובה מדויקת 🙂";
}

async function getOpeningMessage(name) {
  const config = await getAiAgentConfig();
  const firstName = name ? String(name).split(" ")[0] : "";
  const greeting = firstName ? `שלום ${firstName}` : "שלום";
  const template =
    config.inbound?.openingTemplate ||
    "היי, כאן אליה מ-Tori 👋 איך אפשר לעזור?";
  return template
    .replace(/\{greeting\}/g, greeting)
    .replace(/\{name\}/g, firstName);
}

async function getFirstLeadMessage(messageName) {
  const config = await getAiAgentConfig();
  const name = String(messageName || "").trim();
  const template =
    config.outbound?.firstMessageTemplate ||
    "היי {name}, כאן אליה מ-Tori 👋 ראיתי שהשארת פרטים לגבי אפליקציה אישית לניהול תורים לעסק. אשמח להסביר בקצרה איך זה עובד — מה סוג העסק שלך?";
  const greeting = name ? `היי ${name}` : "היי";
  return template.replace(/\{name\}/g, name).replace(/\{greeting\}/g, greeting);
}

function formatProactiveTranscript(messages) {
  return messages
    .filter((m) => ["user", "bot", "human_agent"].includes(m.role))
    .map((m) => {
      const speaker = m.role === "user" ? "לקוח" : "אליה";
      return `${speaker}: ${String(m.content || "").trim()}`;
    })
    .join("\n");
}

async function getProactiveAIReply(_phone, _incomingText, dbMessages) {
  const transcript = formatProactiveTranscript(dbMessages);
  const prompt = `תמליל השיחה המלא בוואטסאפ:

${transcript}

---

כתבי את התשובה הבאה של אליה להודעה האחרונה של הלקוח, לפי ההנחיות שקיבלת.
החזירי הודעה אחת בלבד — רק את תוכן ההודעה, בלי תווית ובלי הסברים.`;

  const config = await getAiAgentConfig();
  const systemInstruction = resolveOutboundSystemPrompt(config);

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await completeText({
        systemInstruction,
        userPrompt: prompt,
        maxAttempts: 1,
      });
      const reply = formatBotReply(raw);
      if (reply) return reply;
      console.warn("⚠️ (שיחה יזומה) תשובה ריקה — מנסה שוב");
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) throw err;
    }
  }

  if (lastErr) throw lastErr;
  return "";
}

async function previewInboundPrompt() {
  const config = await getAiAgentConfig();
  return resolveInboundSystemPrompt(config);
}

async function previewOutboundPrompt() {
  const config = await getAiAgentConfig();
  return resolveOutboundSystemPrompt(config);
}

function sessionMessagesToGeminiHistory(messages) {
  return messages.map((m) => ({
    role: m.role === "bot" ? "model" : "user",
    parts: [{ text: String(m.content || "") }],
  }));
}

async function generateTrainingInboundReply(priorMessages, userText) {
  const history = sessionMessagesToGeminiHistory(priorMessages);
  const histForChat = historyStartingWithUser(history);
  const config = await getAiAgentConfig();
  const systemInstruction = resolveInboundSystemPrompt(config);

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await chatText({
        systemInstruction,
        history: histForChat,
        userMessage: userText,
        maxAttempts: 1,
      });
      const reply = formatBotReply(raw);
      if (reply) return reply;
      console.warn("⚠️ אימון inbound — תשובה ריקה, מנסה שוב");
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) throw err;
    }
  }

  if (lastErr) throw lastErr;
  return "רגע, אני בודקת ואחזור אלייך עם תשובה מדויקת 🙂";
}

async function generateTrainingOutboundReply(priorMessages, userText) {
  const dbMessages = priorMessages.map((m) => ({
    role: m.role === "bot" ? "bot" : "user",
    content: m.content,
  }));
  dbMessages.push({ role: "user", content: userText });

  const transcript = formatProactiveTranscript(dbMessages);
  const prompt = `תמליל השיחה המלא בוואטסאפ:

${transcript}

---

כתבי את התשובה הבאה של אליה להודעה האחרונה של הלקוח, לפי ההנחיות שקיבלת.
החזירי הודעה אחת בלבד — רק את תוכן ההודעה, בלי תווית ובלי הסברים.`;

  const config = await getAiAgentConfig();
  const systemInstruction = resolveOutboundSystemPrompt(config);

  const maxAttempts = 5;
  let lastErr;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await completeText({
        systemInstruction,
        userPrompt: prompt,
        maxAttempts: 1,
      });
      const reply = formatBotReply(raw);
      if (reply) return reply;
      console.warn("⚠️ אימון outbound — תשובה ריקה, מנסה שוב");
    } catch (err) {
      lastErr = err;
      if (attempt === maxAttempts - 1) throw err;
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
  previewInboundPrompt,
  previewOutboundPrompt,
  generateTrainingInboundReply,
  generateTrainingOutboundReply,
  regenerateAgentReplyWithTrainerNote,
  ruleBasedRevisionFallback,
  isGeminiQuotaError: isQuotaError,
  formatGeminiUserError: formatAIUserError,
  conversations,
};
