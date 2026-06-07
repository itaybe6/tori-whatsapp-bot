require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const ws = require("ws");

const rawUrl = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;
const url = rawUrl ? new URL(rawUrl).origin : "";

if (!url || !key) {
  console.warn(
    "⚠️ Supabase: חסרים SUPABASE_URL או SUPABASE_SERVICE_KEY — פעולות DB ייכשלו עד שתמלא אותם ב-.env"
  );
}

// Node.js < 22: Supabase Realtime דורש חבילת ws כ-transport (אין WebSocket מובנה)
const supabase =
  url && key
    ? createClient(url, key, {
        realtime: { transport: ws },
      })
    : null;

function requireClient() {
  if (!supabase) {
    throw new Error("Supabase לא מוגדר: הגדר SUPABASE_URL ו-SUPABASE_SERVICE_KEY");
  }
  return supabase;
}

function wrapDbError(err) {
  const code = err?.cause?.code || "";
  const host = err?.cause?.hostname || "";
  const msg = String(err?.message || err);
  if (
    code === "ENOTFOUND" ||
    msg.includes("fetch failed") ||
    msg.includes("ENOTFOUND")
  ) {
    const hostHint = host ? ` (${host})` : "";
    return new Error(
      `לא ניתן להתחבר ל-Supabase${hostHint}. פתח supabase.com/dashboard → Project Settings → API, והעתק את Project URL ו-service_role key לקובץ .env. ודא שהפרויקט קיים ולא נמחק.`
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

async function checkConnection() {
  const db = requireClient();
  const { error } = await db.from("leads").select("id").limit(1);
  if (error) throw wrapDbError(error);
  return true;
}

/**
 * מוסיף שיחה או מעדכן name / last_message_at
 */
async function upsertConversation(phone, name) {
  const db = requireClient();
  const now = new Date().toISOString();
  const { error } = await db.from("conversations").upsert(
    {
      phone,
      name: name ?? "",
      last_message_at: now,
    },
    { onConflict: "phone" }
  );
  if (error) throw error;
}

/**
 * מחזיר status של השיחה — ברירת מחדל 'bot' אם אין רשומה
 */
async function getConversationStatus(phone) {
  const db = requireClient();
  const { data, error } = await db
    .from("conversations")
    .select("status")
    .eq("phone", phone)
    .maybeSingle();
  if (error) throw error;
  if (!data) return "bot";
  return data.status;
}

/**
 * שומר הודעה ומעדכן תצוגת הודעה אחרונה בשיחה
 */
async function saveMessage(phone, role, content) {
  const db = requireClient();
  const text = typeof content === "string" ? content : String(content);
  const { error: insErr } = await db.from("messages").insert({
    phone,
    role,
    content: text,
  });
  if (insErr) throw insErr;

  const { error: updErr } = await db
    .from("conversations")
    .update({
      last_message_at: new Date().toISOString(),
      last_message: text.slice(0, 2000),
    })
    .eq("phone", phone);
  if (updErr) throw updErr;
}

async function setConversationStatus(phone, status) {
  const db = requireClient();
  const { data: existing, error: selErr } = await db
    .from("conversations")
    .select("phone")
    .eq("phone", phone)
    .maybeSingle();
  if (selErr) throw selErr;

  if (!existing) {
    const { error } = await db.from("conversations").insert({
      phone,
      name: "",
      status,
      last_message_at: new Date().toISOString(),
      last_message: "",
    });
    if (error) throw error;
  } else {
    const { error } = await db
      .from("conversations")
      .update({ status })
      .eq("phone", phone);
    if (error) throw error;
  }
}

async function getConversations() {
  const db = requireClient();
  const { data, error } = await db
    .from("conversations")
    .select("phone, name, status, last_message_at, last_message")
    .order("last_message_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

async function getMessages(phone) {
  const db = requireClient();
  const { data, error } = await db
    .from("messages")
    .select("id, phone, role, content, created_at")
    .eq("phone", phone)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * מוחק שיחה (וההודעות שלה — בזכות ON DELETE CASCADE בסכמה).
 */
async function deleteConversation(phone) {
  const db = requireClient();
  const { error } = await db.from("conversations").delete().eq("phone", phone);
  if (error) throw error;
}

async function getLeads() {
  try {
    const db = requireClient();
    const { data, error } = await db
      .from("leads")
      .select(
        "id, name, business, phone, business_type, notes, source, status, created_at"
      )
      .order("created_at", { ascending: false });
    if (error) throw error;
    return data ?? [];
  } catch (err) {
    throw wrapDbError(err);
  }
}

/**
 * מחזיר רק לידים שנוצרו אחרי isoTimestamp (exclusive).
 * שימושי ל-polling של לידים חדשים.
 */
async function getLeadsCreatedAfter(isoTimestamp) {
  const db = requireClient();
  const { data, error } = await db
    .from("leads")
    .select(
      "id, name, business, phone, business_type, notes, source, status, created_at"
    )
    .gt("created_at", isoTimestamp)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

/**
 * מחזיר Set של כל מספרי הטלפון הקיימים בטבלת leads (למניעת כפילויות בייבוא).
 */
async function getExistingLeadPhones() {
  try {
    const db = requireClient();
    const { data, error } = await db.from("leads").select("phone");
    if (error) throw error;
    return new Set((data ?? []).map((r) => r.phone));
  } catch (err) {
    throw wrapDbError(err);
  }
}

const LEADS_INSERT_CHUNK = 50;

const LEAD_STATUSES = new Set([
  "no_contact",
  "message_sent",
  "relevant",
  "not_relevant",
]);

/**
 * מוסיף לידים בכמות — בחלקים של 50 שורות.
 */
async function updateLeadStatus(id, status) {
  if (!LEAD_STATUSES.has(status)) {
    throw new Error("סטטוס לא תקין");
  }
  try {
    const db = requireClient();
    const { data, error } = await db
      .from("leads")
      .update({ status })
      .eq("id", id)
      .select("id, status")
      .maybeSingle();
    if (error) throw error;
    if (!data) throw new Error("ליד לא נמצא");
    return data;
  } catch (err) {
    throw wrapDbError(err);
  }
}

async function bulkInsertLeads(leads) {
  if (!leads.length) return [];
  try {
    const db = requireClient();
    const inserted = [];

    for (let i = 0; i < leads.length; i += LEADS_INSERT_CHUNK) {
      const chunk = leads.slice(i, i + LEADS_INSERT_CHUNK);
      const { data, error } = await db.from("leads").insert(chunk).select();
      if (error) throw error;
      inserted.push(...(data ?? []));
    }

    return inserted;
  } catch (err) {
    throw wrapDbError(err);
  }
}

module.exports = {
  upsertConversation,
  getConversationStatus,
  saveMessage,
  setConversationStatus,
  getConversations,
  getMessages,
  deleteConversation,
  getLeads,
  getLeadsCreatedAfter,
  getExistingLeadPhones,
  bulkInsertLeads,
  updateLeadStatus,
  checkConnection,
  wrapDbError,
  LEAD_STATUSES,
};
