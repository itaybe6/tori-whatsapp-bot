require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const {
  sendMessage,
  sendProactiveMessage,
  startTypingIndicator,
} = require("./src/whatsapp");
const { parseExcelBuffer } = require("./src/excelImport");
const { extractMessageName } = require("./src/leadMessageName");
const {
  getReply,
  getOpeningMessage,
  getFirstLeadMessage,
  getProactiveAIReply,
  isGeminiQuotaError,
  formatGeminiUserError,
  conversations,
} = require("./src/agent");
const {
  detectLeadStatus,
  sanitizeProactiveReply,
  shouldReplyToInbound,
  isGreetingOnly,
  isNoAnswerSignal,
  detectHandoffReason,
  HANDOFF_REASONS,
} = require("./src/proactiveFlow");
const { getHumanReplyDelayMs } = require("./src/humanDelay");
const { getAppSetting, setAppSetting } = require("./src/appSettings");
const {
  getAiAgentConfig,
  setAiAgentConfig,
  resetAiAgentConfig,
  getDefaultAiAgentConfig,
} = require("./src/aiAgentConfig");
const {
  previewInboundPrompt,
  previewOutboundPrompt,
} = require("./src/agent");
const {
  startTrainingSession,
  trainingChat,
  addTrainingFeedback,
  summarizeTrainingSession,
  applyTrainingSummary,
  discardTrainingSession,
} = require("./src/aiTraining");
const {
  startHourlyNoContactScheduler,
  getIsraelTimeParts,
} = require("./src/hourlyNoContact");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** מונע עיבוד כפול של אותה הודעת webhook מ-Meta */
const processedWebhookIds = new Map();
const WEBHOOK_DEDUPE_MS = 24 * 60 * 60 * 1000;

function isDuplicateWebhookMessage(messageId) {
  if (!messageId) return false;
  const now = Date.now();
  for (const [id, ts] of processedWebhookIds.entries()) {
    if (now - ts > WEBHOOK_DEDUPE_MS) processedWebhookIds.delete(id);
  }
  if (processedWebhookIds.has(messageId)) return true;
  processedWebhookIds.set(messageId, now);
  return false;
}

const AUTO_OPENING_SKIP_SOURCES = new Set(["manual", "excel-import"]);

const {
  upsertConversation,
  getConversationStatus,
  saveMessage,
  markConversationProactive,
  isConversationProactive,
  markLeadStatusByPhone,
  markLeadActiveByPhone,
  setConversationStatus,
  getConversations,
  getMessages,
  deleteConversation,
  getLeads,
  getLeadById,
  getLeadsCreatedAfter,
  getExistingLeadPhones,
  bulkInsertLeads,
  updateLead,
  backfillMessageNames,
  createLead,
  deleteLead,
  checkConnection,
} = require("./src/db");

const app = express();
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    const ok =
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.mimetype === "application/vnd.ms-excel" ||
      /\.xlsx?$/i.test(file.originalname || "");
    cb(ok ? null : new Error("רק קבצי Excel (.xlsx) נתמכים"), ok);
  },
});

const recentAgentSends = new Map();
const AGENT_SEND_DEDUPE_MS = 10000;

const FIRST_MESSAGE_ALLOWED_SOURCES = new Set(["manual", "excel-import"]);

function canSendFirstMessageToLead(lead) {
  return FIRST_MESSAGE_ALLOWED_SOURCES.has(String(lead?.source || ""));
}

function isDuplicateAgentSend(phone, message) {
  const normalizedMessage = String(message).trim();
  const key = `${phone}:${normalizedMessage}`;
  const now = Date.now();

  for (const [storedKey, sentAt] of recentAgentSends.entries()) {
    if (now - sentAt > AGENT_SEND_DEDUPE_MS) {
      recentAgentSends.delete(storedKey);
    }
  }

  const lastSentAt = recentAgentSends.get(key);
  return Boolean(lastSentAt && now - lastSentAt < AGENT_SEND_DEDUPE_MS);
}

function markAgentSend(phone, message) {
  const normalizedMessage = String(message).trim();
  recentAgentSends.set(`${phone}:${normalizedMessage}`, Date.now());
}

function friendlyWhatsAppSendError(message) {
  const text = String(message || "");
  const expiredMatch = text.match(/Session has expired on ([^.]+)/i);
  if (expiredMatch) {
    return `שגיאת WhatsApp — ה-Token שב-.env פג תוקף (${expiredMatch[1]}). הדבק System User Token קבוע והפעל מחדש npm start`;
  }
  if (/authentication|oauth|session has expired|invalid.*token|code.*190/i.test(text)) {
    return "שגיאת WhatsApp — ה-Token לא תקף. ודא שהדבקת System User Token קבוע ב-WHATSAPP_TOKEN והפעל מחדש npm start";
  }
  if (/131047|63016|24.?hour|outside.*window/i.test(text)) {
    return "חלון 24 השעות נסגר — לא ניתן לשלוח הודעה חופשית. שלח template מאושר או המתן להודעה מהלקוח";
  }
  return text || "שגיאת שליחה";
}

// ============================================================
// התראות לנציגים — כשהבוט צריך שיתערבו (לא ידע לענות / לקוחה מעוניינת)
// ============================================================
const ADMIN_ALERT_NUMBERS = (
  process.env.ADMIN_ALERT_NUMBERS || "0502307500,0527488779"
)
  .split(",")
  .map((n) => normalizePhone(n.trim()))
  .filter(Boolean);

const ADMIN_ALERT_MESSAGE = "הבוט צריך שתתערבו - אנא כנסו למערכת ההודעות";
const ADMIN_ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const recentAdminAlerts = new Map();

function shouldSendAdminAlert(key) {
  const now = Date.now();
  for (const [k, t] of recentAdminAlerts.entries()) {
    if (now - t > ADMIN_ALERT_COOLDOWN_MS) recentAdminAlerts.delete(k);
  }
  if (recentAdminAlerts.has(key)) return false;
  recentAdminAlerts.set(key, now);
  return true;
}

const ADMIN_ALERT_REASONS = {
  needs_human: "הבוט לא ידע לתת מענה",
  interested: "הלקוח הביע עניין",
  sales: "הלקוח מעוניין להצטרף — צריך לחזור אליו",
  support: "פנייה בנושא תמיכה או תקלה",
  cancel: "בקשת ביטול",
  unknown_answer: "שאלה שהבוט לא ידע לענות עליה",
};

/**
 * שולח התראה לנציגים. reason: מפתח מתוך ADMIN_ALERT_REASONS.
 * dedup לפי לקוח+סיבה כדי לא להציף. נכשל בשקט — לא משבש את השיחה.
 */
async function notifyAdmins(reason, customerPhone, customerName) {
  if (!ADMIN_ALERT_NUMBERS.length) return;
  if (!shouldSendAdminAlert(`${customerPhone}:${reason}`)) return;

  const who = customerName
    ? `${customerName} (${customerPhone})`
    : customerPhone;
  const reasonText = ADMIN_ALERT_REASONS[reason] || ADMIN_ALERT_REASONS.interested;
  const text = `🔔 ${ADMIN_ALERT_MESSAGE}\n${reasonText}\nלקוח: ${who}`;

  for (const admin of ADMIN_ALERT_NUMBERS) {
    if (admin === customerPhone) continue;
    try {
      await sendMessage(admin, text);
    } catch (err) {
      console.error(`❌ התראת נציג ל-${admin} נכשלה:`, err.message);
    }
  }
  console.log(`📣 נשלחה התראת נציג (${reason}) עבור ${customerPhone}`);
}

// CORS — דשבורד על פורט 3001 קורא ל-API על פורט אחר
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

let supabaseAuthClient = null;
function getSupabaseAuthClient() {
  if (
    !supabaseAuthClient &&
    process.env.SUPABASE_URL &&
    process.env.SUPABASE_SERVICE_KEY
  ) {
    supabaseAuthClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false, autoRefreshToken: false } }
    );
  }
  return supabaseAuthClient;
}

async function requireDashboardAuth(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "נדרשת התחברות" });
  }
  const client = getSupabaseAuthClient();
  if (!client) {
    return res.status(503).json({ error: "התחברות לא מוגדרת בשרת" });
  }
  const token = authHeader.slice(7);
  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: "התחברות לא תקינה או שפג תוקפה" });
  }
  req.authUser = user;
  next();
}

app.use("/api", requireDashboardAuth);
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

app.get("/api/health", async (_req, res) => {
  try {
    await checkConnection();
    res.json({ ok: true, supabase: true });
  } catch (err) {
    res.status(503).json({ ok: false, supabase: false, error: err.message });
  }
});

app.get("/api/settings/hourly-no-contact", async (_req, res) => {
  try {
    const enabled = await getAppSetting("hourly_no_contact_enabled", false);
    res.json({ enabled: Boolean(enabled) });
  } catch (err) {
    console.error("❌ get hourly-no-contact setting:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/settings/hourly-no-contact", async (req, res) => {
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") {
    return res.status(400).json({ error: "חסר enabled (boolean)" });
  }
  try {
    await setAppSetting("hourly_no_contact_enabled", enabled);
    if (!enabled) {
      await setAppSetting("hourly_no_contact_last_slot", null);
    } else {
      const { slotKey } = getIsraelTimeParts();
      await setAppSetting("hourly_no_contact_last_slot", slotKey);
    }
    console.log(
      `${enabled ? "✅" : "⏸️"} שליחה שעתית ללידים ללא קשר: ${enabled ? "פעילה" : "כבויה"}`
    );
    res.json({ enabled });
  } catch (err) {
    console.error("❌ set hourly-no-contact setting:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-agent", async (_req, res) => {
  try {
    const config = await getAiAgentConfig();
    const inboundPreview = await previewInboundPrompt();
    const outboundPreview = await previewOutboundPrompt();
    res.json({
      config,
      previews: { inbound: inboundPreview, outbound: outboundPreview },
    });
  } catch (err) {
    console.error("❌ get ai-agent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/ai-agent", async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object") {
    return res.status(400).json({ error: "חסר גוף בקשה" });
  }
  try {
    const config = await setAiAgentConfig(body);
    const inboundPreview = await previewInboundPrompt();
    const outboundPreview = await previewOutboundPrompt();
    console.log("✅ הגדרות נציג AI עודכנו");
    res.json({
      config,
      previews: { inbound: inboundPreview, outbound: outboundPreview },
    });
  } catch (err) {
    console.error("❌ patch ai-agent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-agent/reset", async (_req, res) => {
  try {
    const config = await resetAiAgentConfig();
    const inboundPreview = await previewInboundPrompt();
    const outboundPreview = await previewOutboundPrompt();
    console.log("↩️ הגדרות נציג AI אופסו לברירת מחדל");
    res.json({
      config,
      previews: { inbound: inboundPreview, outbound: outboundPreview },
    });
  } catch (err) {
    console.error("❌ reset ai-agent:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/ai-agent/defaults", async (_req, res) => {
  try {
    const config = getDefaultAiAgentConfig();
    res.json({ config });
  } catch (err) {
    console.error("❌ ai-agent defaults:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-agent/training/start", async (req, res) => {
  const mode = req.body?.mode;
  if (mode !== "inbound" && mode !== "outbound") {
    return res.status(400).json({ error: "mode חייב inbound או outbound" });
  }
  try {
    const data = await startTrainingSession(mode);
    res.json(data);
  } catch (err) {
    trainingApiError(res, err, "training start");
  }
});

function trainingApiError(res, err, label) {
  console.error(`❌ ${label}:`, err);
  const status = isGeminiQuotaError(err) ? 429 : 500;
  res.status(status).json({ error: formatGeminiUserError(err) });
}

app.post("/api/ai-agent/training/chat", async (req, res) => {
  const { sessionId, message } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "חסר sessionId" });
  }
  try {
    const data = await trainingChat(sessionId, message);
    res.json(data);
  } catch (err) {
    trainingApiError(res, err, "training chat");
  }
});

app.post("/api/ai-agent/training/feedback", async (req, res) => {
  const { sessionId, note } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "חסר sessionId" });
  }
  try {
    const data = addTrainingFeedback(sessionId, note);
    res.json(data);
  } catch (err) {
    console.error("❌ training feedback:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-agent/training/summarize", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "חסר sessionId" });
  }
  try {
    const data = await summarizeTrainingSession(sessionId);
    res.json(data);
  } catch (err) {
    trainingApiError(res, err, "training summarize");
  }
});

app.post("/api/ai-agent/training/apply", async (req, res) => {
  const { sessionId, revisedPrompt } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "חסר sessionId" });
  }
  try {
    const data = await applyTrainingSummary(sessionId, revisedPrompt);
    console.log("✅ פרומפט נציג AI עודכן מאימון");
    res.json(data);
  } catch (err) {
    console.error("❌ training apply:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/ai-agent/training/discard", async (req, res) => {
  const { sessionId } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: "חסר sessionId" });
  }
  discardTrainingSession(sessionId);
  res.json({ ok: true });
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

app.post("/api/leads", async (req, res) => {
  const { business, phone, business_type, name, notes } = req.body || {};
  const businessName = String(business || "").trim();
  const phoneNorm = normalizePhone(phone);

  if (!businessName) {
    return res.status(400).json({ error: "חסר שם עסק" });
  }
  if (!phoneNorm) {
    return res.status(400).json({ error: "מספר טלפון לא תקין" });
  }

  try {
    const existing = await getExistingLeadPhones();
    if (existing.has(phoneNorm)) {
      return res.status(400).json({ error: "מספר טלפון כבר קיים בטבלה" });
    }

    const row = await createLead({
      name: String(name || businessName).trim(),
      business: businessName,
      phone: phoneNorm,
      business_type: String(business_type || "סלון ציפורניים").trim(),
      notes: notes ? String(notes).trim() : null,
      source: "manual",
      message_name: extractMessageName(businessName),
    });

    console.log(`➕ ליד חדש נוסף ידנית: ${row.business} (${row.phone})`);
    res.json(row);
  } catch (err) {
    console.error("❌ create lead:", err);
    res.status(500).json({ error: err.message });
  }
});

app.patch("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  const { status, message_name } = req.body || {};
  if (!id || (status === undefined && message_name === undefined)) {
    return res.status(400).json({ error: "חסר id או שדה לעדכון" });
  }
  try {
    const row = await updateLead(id, { status, message_name });
    res.json(row);
  } catch (err) {
    console.error("❌ update lead:", err);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/leads/:id", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: "חסר id" });
  }
  try {
    await deleteLead(id);
    console.log(`🗑️  ליד נמחק: ${id}`);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ delete lead:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leads/:id/send-first-message", async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: "חסר id" });
  }

  try {
    const lead = await getLeadById(id);
    if (!lead) {
      return res.status(404).json({ error: "ליד לא נמצא" });
    }

    if (!canSendFirstMessageToLead(lead)) {
      return res.status(403).json({
        error: "שליחת הודעה ראשונה זמינה רק ללידים ממקור ידני או ייבוא Excel",
      });
    }

    const messageName = String(lead.message_name || "").trim();
    if (!messageName) {
      return res.status(400).json({ error: "חסר שם לשליחת הודעה" });
    }

    const phone = normalizePhone(lead.phone);
    if (!phone) {
      return res.status(400).json({ error: "מספר טלפון לא תקין" });
    }

    const text = await getFirstLeadMessage(messageName);
    await upsertConversation(phone, messageName);
    await markConversationProactive(phone);
    await sendProactiveMessage(phone, messageName, getFirstLeadTemplateOptions());
    await saveMessage(phone, "bot", text);
    await updateLead(id, { status: "message_sent" });
    conversations.set(phone, [{ role: "model", parts: [{ text }] }]);

    console.log(`📨 הודעה ראשונה נשלחה ל-${messageName} (${phone})`);
    res.json({ success: true, phone, message: text });
  } catch (err) {
    console.error("❌ send first message:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/leads/import", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "חסר קובץ Excel (שדה file)" });
  }

  const sendOpeningFlag =
    req.body?.sendOpening === "true" || req.body?.sendOpening === true;
  const businessType = req.body?.businessType || "סלון ציפורניים";

  try {
    const { leads, errors } = parseExcelBuffer(req.file.buffer, {
      businessType,
    });
    const existing = await getExistingLeadPhones();
    const toInsert = [];
    let skipped = 0;

    for (const lead of leads) {
      if (existing.has(lead.phone)) {
        skipped++;
        continue;
      }
      existing.add(lead.phone);
      toInsert.push(lead);
    }

    const inserted = await bulkInsertLeads(toInsert);
    let openingsSent = 0;

    if (inserted.length) {
      const newest = inserted[inserted.length - 1].created_at;
      if (sendOpeningFlag) {
        for (const lead of inserted) {
          try {
            const result = await sendOpening(
              lead.phone,
              lead.message_name || lead.name || ""
            );
            if (!result.skipped) openingsSent++;
          } catch (err) {
            console.error(
              `❌ פתיחה לליד ${lead.phone}:`,
              err.message
            );
          }
        }
        lastSeenLeadCreatedAt = newest;
      } else {
        lastSeenLeadCreatedAt = newest;
      }
    }

    console.log(
      `📥 ייבוא Excel: ${inserted.length} נוספו, ${skipped} דולגו, ${errors.length} שגיאות פרסור`
    );

    res.json({
      success: true,
      parsed: leads.length,
      inserted: inserted.length,
      skipped,
      openingsSent,
      parseErrors: errors,
    });
  } catch (err) {
    console.error("❌ import leads:", err);
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
    markAgentSend(phone, text);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ send-as-agent:", err);
    res.status(500).json({ error: friendlyWhatsAppSendError(err.message) });
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

  let stopTyping = () => {};
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];
    const statusUpdate = value?.statuses?.[0];

    if (statusUpdate) {
      const { status, recipient_id: to, errors } = statusUpdate;
      if (status === "failed") {
        console.error(
          `❌ משלוח נכשל ל-${to}:`,
          errors?.map((e) => `${e.code}: ${e.title}`).join("; ") || statusUpdate
        );
      } else if (status === "delivered") {
        console.log(`📬 נמסר ל-${to}`);
      } else if (status === "read") {
        console.log(`👁️  נקרא על ידי ${to}`);
      }
      return;
    }

    if (!message) return;

    if (isDuplicateWebhookMessage(message.id)) {
      console.log(`↻ webhook כפול — מדלג (${message.id})`);
      return;
    }

    // מסנן רק הודעות טקסט
    if (message.type !== "text") {
      console.log(`⚠️ סוג הודעה לא נתמך: ${message.type}`);
      return;
    }

    const from = message.from; // מספר הטלפון של השולח
    const text = String(message.text?.body || "").trim();
    if (!text) return;
    const name = value?.contacts?.[0]?.profile?.name || "";

    console.log(`\n📩 הודעה נכנסת`);
    console.log(`   מ: ${name} (${from})`);
    console.log(`   תוכן: ${text}`);

    await upsertConversation(from, name);

    const convStatus = await getConversationStatus(from);
    if (convStatus === "human" || convStatus === "needs_human") {
      await saveMessage(from, "user", text);
      await markLeadActiveByPhone(from);
      console.log(
        convStatus === "needs_human"
          ? `   ממתין לנציג (הבוט לא ידע לתת מענה) — הבוט לא עונה`
          : `   מצב נציג אנושי — הבוט לא עונה`
      );
      return;
    }

    await saveMessage(from, "user", text);
    await markLeadActiveByPhone(from);

    const allMessages = await getMessages(from);

    if (!shouldReplyToInbound(allMessages, text)) {
      console.log(`   מדלג — אין הודעת לקוח חדשה לענות עליה`);
      return;
    }

    // מכאן אנחנו מתכוונים לענות — מסמנים כנקרא ומציגים "מקליד…" עד השליחה
    stopTyping = startTypingIndicator(message.id);

    const isProactive = await isConversationProactive(from);
    let reply;
    let leadStatus;

    if (isProactive) {
      console.log(
        `   שיחה יזומה — שולח ${allMessages.length} הודעות ל-Gemini`
      );
      reply = await getProactiveAIReply(from, text, allMessages);
      reply = sanitizeProactiveReply(reply, allMessages, text);
      if (!reply) {
        console.log(`   מדלג — תשובת מעקב אסורה (לקוחה לא ענתה / שאלה חוזרת)`);
        return;
      }
      leadStatus = detectLeadStatus(allMessages, text);
    } else {
      const priorMessages = allMessages.slice(0, -1);
      const isFirstMessage = priorMessages.length === 0;

      if (!conversations.has(from) && priorMessages.length > 0) {
        const hydrated = priorMessages.map((m) => ({
          role: m.role === "user" ? "user" : "model",
          parts: [{ text: m.content || "" }],
        }));
        conversations.set(from, hydrated);
      }

      // הודעה ראשונה שהיא ברכה בלבד — תבנית הפתיחה של שיחות נכנסות משמשת
      // כתשובה עצמה, כדי שלא תישלח גם פתיחה וגם תשובת AI באותה נשימה.
      if (isFirstMessage && isGreetingOnly(text)) {
        reply = await getOpeningMessage(name);
        conversations.set(from, [
          { role: "user", parts: [{ text }] },
          { role: "model", parts: [{ text: reply }] },
        ]);
      } else {
        reply = await getReply(from, text);
      }
    }

    if (isNoAnswerSignal(reply)) {
      await setConversationStatus(from, "needs_human", HANDOFF_REASONS.NO_ANSWER);
      console.log(
        `   🚨 הבוט לא ידע לתת מענה — סטטוס השיחה הועבר ל-needs_human (ממתין לנציג)`
      );
      await notifyAdmins("needs_human", from, name);
      return;
    }

    if (leadStatus) {
      await markLeadStatusByPhone(from, leadStatus);
      console.log(`   סטטוס ליד עודכן: ${leadStatus}`);
    }

    const handoffReason = detectHandoffReason(reply);

    if (handoffReason) {
      await notifyAdmins(handoffReason, from, name);
    } else if (leadStatus === "relevant") {
      await notifyAdmins("interested", from, name);
    }

    const delayMs = getHumanReplyDelayMs(text, reply);
    console.log(`   ממתין ${(delayMs / 1000).toFixed(1)}s לפני שליחה`);
    await sleep(delayMs);

    console.log(`   תשובה: ${reply}`);
    await saveMessage(from, "bot", reply);
    await sendMessage(from, reply);

    // הבוט הודיע ללקוח שהשיחה עוברת לנציג — מסמנים בדשבורד ומשתיקים את הבוט,
    // כדי שהוא לא ימשיך לענות אחרי שהובטח מענה אנושי.
    if (handoffReason) {
      await setConversationStatus(from, "needs_human", handoffReason);
      if (handoffReason === HANDOFF_REASONS.SALES) {
        await markLeadStatusByPhone(from, "relevant");
      }
      console.log(
        `   🙋 הבוט העביר לנציג (${handoffReason}) — השיחה סומנה כדורשת מענה ידני`
      );
    }
  } catch (err) {
    console.error("❌ שגיאה בעיבוד הודעה:", err);
  } finally {
    stopTyping();
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

function getFirstLeadTemplateOptions() {
  if (process.env.WHATSAPP_FIRST_LEAD_TEMPLATE) {
    return {
      templateName: process.env.WHATSAPP_FIRST_LEAD_TEMPLATE,
      languageCode:
        process.env.WHATSAPP_FIRST_LEAD_TEMPLATE_LANG ||
        process.env.WHATSAPP_OPENING_TEMPLATE_LANG ||
        "he",
      useNameVar:
        process.env.WHATSAPP_FIRST_LEAD_TEMPLATE_HAS_NAME !== "false",
    };
  }
  return {
    templateName: process.env.WHATSAPP_OPENING_TEMPLATE || "tori_first_contact",
    languageCode: process.env.WHATSAPP_OPENING_TEMPLATE_LANG || "he",
    useNameVar: process.env.WHATSAPP_OPENING_TEMPLATE_HAS_NAME === "true",
  };
}

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
  const existingMsgs = await getMessages(normalized);
  if (existingMsgs.length > 0) {
    console.log(`↻ דילגנו על פתיחה — כבר יש שיחה עם ${normalized}`);
    return { skipped: true, phone: normalized, reason: "has_messages" };
  }
  const opening = await getOpeningMessage(name || "");
  await upsertConversation(normalized, name || "");
  await markConversationProactive(normalized);
  await sendProactiveMessage(normalized, name || "");
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
      if (AUTO_OPENING_SKIP_SOURCES.has(lead.source)) {
        continue;
      }
      if (lead.status && lead.status !== "no_contact") {
        continue;
      }
      try {
        const result = await sendOpening(
          lead.phone,
          lead.message_name || lead.name || ""
        );
        if (result.skipped) continue;
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

startHourlyNoContactScheduler({
  normalizePhone,
  canSendFirstMessageToLead,
  upsertConversation,
  markConversationProactive,
  saveMessage,
  getFirstLeadTemplateOptions,
  sendOpening,
  conversations,
});

// ============================================================
// STATUS CHECK
// ============================================================
app.get("/", (req, res) => {
  res.json({
    status: "🟢 Tori Bot פועל",
    activeConversations: conversations.size,
    dashboardApi:
      "GET /api/conversations, GET /api/messages/:phone, GET /api/leads, PATCH /api/leads/:id, POST /api/leads/import",
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Tori WhatsApp Bot רץ על פורט ${PORT}`);
  console.log(`📡 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`📤 שליחה יזומה: POST http://localhost:${PORT}/send-opening`);
  console.log(`📊 API דשבורד: http://localhost:${PORT}/api/conversations`);
  console.log(
    `💡 לקבלת תשובות מלקוחות: הרץ npm run tunnel (טרמינל נפרד) ועדכן Webhook ב-Meta לכתובת ה-ngrok\n`
  );

  checkConnection()
    .then(() => console.log("✅ Supabase מחובר"))
    .catch((err) =>
      console.warn(`⚠️ Supabase לא זמין: ${err.message}`)
    );

  backfillMessageNames()
    .then((n) => {
      if (n > 0) console.log(`✏️  שמות לשליחת הודעה עודכנו אוטומטית: ${n}`);
    })
    .catch((err) =>
      console.warn(`⚠️ אתחול שמות לידים: ${err.message}`)
    );
});
