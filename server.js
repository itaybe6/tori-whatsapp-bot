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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
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
// POST /send-opening  body: { phone: "9725XXXXXXXX", name: "שם" }
// ============================================================
app.post("/send-opening", async (req, res) => {
  const { phone, name } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "חסר מספר טלפון" });
  }

  try {
    const opening = getOpeningMessage(name || "");
    await sendMessage(phone, opening);

    conversations.set(phone, [
      { role: "model", parts: [{ text: opening }] },
    ]);

    console.log(`🚀 פתחנו שיחה עם ${name} (${phone})`);
    res.json({ success: true, message: "הודעת פתיחה נשלחה" });
  } catch (err) {
    console.error("❌ שגיאה בשליחת פתיחה:", err);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// STATUS CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "🟢 Tori Bot פועל",
    activeConversations: conversations.size,
    dashboardApi: "GET /api/conversations, GET /api/messages/:phone",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Tori WhatsApp Bot רץ על פורט ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`📤 שליחה יזומה: POST http://localhost:${PORT}/send-opening`);
  console.log(`📊 API דשבורד: http://localhost:${PORT}/api/conversations\n`);
});
