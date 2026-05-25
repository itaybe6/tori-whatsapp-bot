require("dotenv").config();
const express = require("express");
const { sendMessage } = require("./src/whatsapp");
const {
  getReply,
  getOpeningMessage,
  conversations,
} = require("./src/agent");
const {
  upsertConversation,
  getConversationStatus,
  saveMessage,
  setConversationStatus,
  getConversations,
  getMessages,
  deleteConversation,
  getLeads,
  getLeadsCreatedAfter,
} = require("./src/db");

const app = express();
app.use(express.json());

const recentAgentSends = new Map();
const AGENT_SEND_DEDUPE_MS = 10000;

function isDuplicateAgentSend(phone, message) {
  const normalizedMessage = String(message).trim();
  const key = `${phone}:${normalizedMessage}`;
  const now = Date.now();
  const lastSentAt = recentAgentSends.get(key);

  for (const [storedKey, sentAt] of recentAgentSends.entries()) {
    if (now - sentAt > AGENT_SEND_DEDUPE_MS) {
      recentAgentSends.delete(storedKey);
    }
  }

  if (lastSentAt && now - lastSentAt < AGENT_SEND_DEDUPE_MS) {
    return true;
  }

  recentAgentSends.set(key, now);
  return false;
}

// CORS — דשבורד על פורט 3001 קורא ל-API על פורט אחר
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

// ============================================================
// API — דשבורד ניהול
// ============================================================
app.post("/api/handoff", async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: "חסר phone" });
  }
  try {
    await setConversationStatus(phone, "human");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ handoff:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/handback", async (req, res) => {
  const { phone } = req.body || {};
  if (!phone) {
    return res.status(400).json({ error: "חסר phone" });
  }
  try {
    await setConversationStatus(phone, "bot");
    res.json({ success: true });
  } catch (err) {
    console.error("❌ handback:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/conversations", async (req, res) => {
  try {
    const rows = await getConversations();
    res.json(rows);
  } catch (err) {
    console.error("❌ get conversations:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/messages/:phone", async (req, res) => {
  try {
    const phone = req.params.phone;
    const rows = await getMessages(phone);
    res.json(rows);
  } catch (err) {
    console.error("❌ get messages:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/conversations/:phone", async (req, res) => {
  const phone = req.params.phone;
  if (!phone) {
    return res.status(400).json({ error: "חסר phone" });
  }
  try {
    await deleteConversation(phone);
    conversations.delete(phone);
    console.log(`🗑️  שיחה נמחקה: ${phone}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ delete conversation:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/leads", async (req, res) => {
  try {
    const rows = await getLeads();
    res.json(rows);
  } catch (err) {
    console.error("❌ get leads:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/send-as-agent", async (req, res) => {
  const { phone, message } = req.body || {};
  const text = typeof message === "string" ? message.trim() : "";
  if (!phone || !text) {
    return res.status(400).json({ error: "חסר phone או message" });
  }
  if (isDuplicateAgentSend(phone, text)) {
    console.warn(`⚠️ שליחת נציג כפולה נחסמה: ${phone}`);
    return res.json({ success: true, duplicate: true });
  }
  try {
    await setConversationStatus(phone, "human");
    await sendMessage(phone, text);
    await saveMessage(phone, "human_agent", text);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ send-as-agent:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// WEBHOOK VERIFICATION — Meta קורא לזה פעם אחת בהגדרה
// ============================================================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verified successfully");
    res.status(200).send(challenge);
  } else {
    console.warn("❌ Webhook verification failed");
    res.sendStatus(403);
  }
});

// ============================================================
// INCOMING MESSAGES — מגיע כאן כל הודעה נכנסת
// ============================================================
app.post("/webhook", async (req, res) => {
  // חשוב: להחזיר 200 מיד כדי ש-Meta לא ישלח שוב
  res.sendStatus(200);

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // מסנן status updates (delivered, read וכו')
    if (!message) return;

    // מסנן רק הודעות טקסט
    if (message.type !== "text") {
      console.log(`⚠️ סוג הודעה לא נתמך: ${message.type}`);
      return;
    }

    const from = message.from; // מספר הטלפון של השולח
    const text = message.text.body;
    const name = value?.contacts?.[0]?.profile?.name || "";

    console.log(`\n📩 הודעה נכנסת`);
    console.log(`   מ: ${name} (${from})`);
    console.log(`   תוכן: ${text}`);

    await upsertConversation(from, name);

    const convStatus = await getConversationStatus(from);
    if (convStatus === "human") {
      await saveMessage(from, "user", text);
      console.log(`   מצב נציג אנושי — הבוט לא עונה`);
      return;
    }

    // המקור-אמת להיסטוריה הוא ה-DB (כדי שהבוט ימשיך שיחה גם אחרי restart)
    const priorMessages = await getMessages(from);
    const isFirstMessage = priorMessages.length === 0;

    if (!conversations.has(from) && priorMessages.length > 0) {
      const hydrated = priorMessages.map((m) => ({
        role: m.role === "user" ? "user" : "model",
        parts: [{ text: m.content || "" }],
      }));
      conversations.set(from, hydrated);
    }

    await saveMessage(from, "user", text);

    let reply;

    if (isFirstMessage) {
      const opening = getOpeningMessage(name);
      await sendMessage(from, opening);

      // פורמט Gemini: user | model + parts — רק הפתיחה; getReply יוסיף user + תשובה
      conversations.set(from, [
        { role: "model", parts: [{ text: opening }] },
      ]);

      await saveMessage(from, "bot", opening);

      reply = await getReply(from, text);
    } else {
      reply = await getReply(from, text);
    }

    console.log(`   תשובה: ${reply}`);
    await saveMessage(from, "bot", reply);
    await sendMessage(from, reply);
  } catch (err) {
    console.error("❌ שגיאה בעיבוד הודעה:", err);
  }
});

// ============================================================
// OUTBOUND — שליחה יזומה ללקוח שהשאיר פרטים
// ============================================================

/**
 * מנרמל מספר טלפון לפורמט WhatsApp: ספרות בלבד + קידומת מדינה.
 * אם התחיל ב-0 (ישראלי) — מוסיף 972.
 */
function normalizePhone(raw) {
  let phone = String(raw || "").replace(/\D/g, "");
  if (!phone) return null;
  if (phone.startsWith("0")) {
    phone = "972" + phone.slice(1);
  }
  return phone;
}

const recentOpeningSends = new Map();
const OPENING_DEDUPE_MS = 60_000;

function shouldSendOpening(phone) {
  const now = Date.now();
  for (const [p, t] of recentOpeningSends.entries()) {
    if (now - t > OPENING_DEDUPE_MS) recentOpeningSends.delete(p);
  }
  const last = recentOpeningSends.get(phone);
  if (last && now - last < OPENING_DEDUPE_MS) return false;
  recentOpeningSends.set(phone, now);
  return true;
}

async function sendOpening(phone, name) {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new Error("מספר טלפון לא תקין");
  }
  if (!shouldSendOpening(normalized)) {
    console.log(`↻ דילגנו על הודעת פתיחה כפולה ל-${normalized}`);
    return { skipped: true, phone: normalized };
  }
  const opening = getOpeningMessage(name || "");
  await upsertConversation(normalized, name || "");
  await sendMessage(normalized, opening);
  await saveMessage(normalized, "bot", opening);
  conversations.set(normalized, [
    { role: "model", parts: [{ text: opening }] },
  ]);
  return { skipped: false, phone: normalized };
}

// POST /send-opening  body: { phone: "9725XXXXXXXX", name: "שם" }
app.post("/send-opening", async (req, res) => {
  const { phone, name } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "חסר מספר טלפון" });
  }

  try {
    const result = await sendOpening(phone, name);
    console.log(
      `🚀 פתחנו שיחה עם ${name || ""} (${result.phone})${result.skipped ? " — דילוג (כבר נשלח)" : ""}`
    );
    res.json({ success: true, message: "הודעת פתיחה נשלחה", ...result });
  } catch (err) {
    console.error("❌ שגיאה בשליחת פתיחה:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// LEADS WATCHER — פולינג לטבלת leads בסופאבייס.
// כל ליד חדש (אחרי שהשרת עלה) מקבל הודעת פתיחה אוטומטית בוואטסאפ.
// ============================================================
const LEADS_POLL_MS = 5000;
let lastSeenLeadCreatedAt = null;

async function initLeadsWatcher() {
  try {
    const existing = await getLeads();
    lastSeenLeadCreatedAt =
      existing[0]?.created_at ?? new Date(Date.now() - 1000).toISOString();
    console.log(
      `👀 מאזין ללידים חדשים מרגע: ${lastSeenLeadCreatedAt} (קיימים: ${existing.length})`
    );
  } catch (err) {
    console.warn(
      `⚠️ נכשל איתחול מאזין הלידים (ננסה שוב בסיבוב הבא): ${err.message}`
    );
  }
}

async function pollNewLeads() {
  if (lastSeenLeadCreatedAt == null) {
    await initLeadsWatcher();
    return;
  }
  try {
    const fresh = await getLeadsCreatedAfter(lastSeenLeadCreatedAt);
    if (!fresh.length) return;

    for (const lead of fresh) {
      try {
        await sendOpening(lead.phone, lead.name || "");
        console.log(
          `📨 הודעת פתיחה נשלחה ל-${lead.name || "ליד חדש"} (${lead.phone})`
        );
      } catch (err) {
        console.error(
          `❌ שגיאה בשליחת פתיחה לליד ${lead.id} (${lead.phone}):`,
          err.message
        );
      }
    }

    lastSeenLeadCreatedAt = fresh[fresh.length - 1].created_at;
  } catch (err) {
    console.error("❌ pollNewLeads:", err.message);
  }
}

setInterval(pollNewLeads, LEADS_POLL_MS);
initLeadsWatcher();

// ============================================================
// STATUS CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "🟢 Tori Bot פועל",
    activeConversations: conversations.size,
    dashboardApi:
      "GET /api/conversations, GET /api/messages/:phone, GET /api/leads",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Tori WhatsApp Bot רץ על פורט ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`📤 שליחה יזומה: POST http://localhost:${PORT}/send-opening`);
  console.log(`📊 API דשבורד: http://localhost:${PORT}/api/conversations\n`);
});
