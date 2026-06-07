/**
 * ממלא last_user_message ו-proactive לשיחות קיימות.
 * שימוש: node scripts/backfill-conversations.js
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

async function main() {
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
  });

  const { data: convs, error } = await db
    .from("conversations")
    .select("phone, proactive, last_user_message");
  if (error) throw error;

  let userMsgs = 0;
  let proactive = 0;

  for (const conv of convs ?? []) {
    const patch = {};

    if (!String(conv.last_user_message || "").trim()) {
      const { data: msgs } = await db
        .from("messages")
        .select("content")
        .eq("phone", conv.phone)
        .eq("role", "user")
        .order("created_at", { ascending: false })
        .limit(1);
      const text = msgs?.[0]?.content;
      if (text) {
        patch.last_user_message = String(text).slice(0, 2000);
        userMsgs++;
      }
    }

    if (!conv.proactive) {
      const { data: first } = await db
        .from("messages")
        .select("role")
        .eq("phone", conv.phone)
        .order("created_at", { ascending: true })
        .limit(1);
      if (first?.[0]?.role === "bot") {
        const { data: lead } = await db
          .from("leads")
          .select("source, status")
          .eq("phone", conv.phone)
          .maybeSingle();
        if (
          lead &&
          (lead.status === "message_sent" ||
            lead.status === "active_conversation" ||
            ["manual", "excel-import"].includes(lead.source))
        ) {
          patch.proactive = true;
          proactive++;
        }
      }
    }

    if (Object.keys(patch).length) {
      const { error: updErr } = await db
        .from("conversations")
        .update(patch)
        .eq("phone", conv.phone);
      if (updErr) throw updErr;
    }
  }

  console.log(`✅ עודכנו ${userMsgs} הודעות משתמש, ${proactive} שיחות יזומות`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
