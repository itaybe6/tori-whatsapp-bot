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

module.exports = {
  upsertConversation,
  getConversationStatus,
  saveMessage,
  setConversationStatus,
  getConversations,
  getMessages,
};
