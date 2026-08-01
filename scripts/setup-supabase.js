/**
 * יוצר את כל טבלאות Supabase לפרויקט Tori (הרץ פעם אחת).
 * שימוש: node scripts/setup-supabase.js
 *
 * דורש ב-.env: SUPABASE_URL, SUPABASE_SERVICE_KEY
 * אופציונלי: SUPABASE_ACCESS_TOKEN — להרצת SQL אוטומטית (מ-account tokens)
 */
require("dotenv").config();
const axios = require("axios");
const ws = require("ws");
const { createClient } = require("@supabase/supabase-js");

const SETUP_SQL = `
create table if not exists public.conversations (
  phone text primary key,
  name text not null default '',
  status text not null default 'bot' check (status in ('bot', 'human', 'needs_human', 'closed')),
  handoff_reason text,
  last_message_at timestamptz not null default now(),
  last_message text not null default '',
  last_user_message text not null default '',
  proactive boolean not null default false
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  phone text not null references public.conversations (phone) on delete cascade,
  role text not null check (role in ('user', 'bot', 'human_agent')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_messages_phone_created on public.messages (phone, created_at);
create index if not exists idx_conversations_last_message_at on public.conversations (last_message_at desc);

create table if not exists public.leads (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  business text not null,
  phone text not null,
  business_type text not null,
  notes text,
  source text default 'landing-page',
  status text not null default 'no_contact'
    check (status in ('no_contact', 'message_sent', 'active_conversation', 'relevant', 'not_relevant')),
  message_name text not null default '',
  created_at timestamptz not null default now()
);

alter table public.leads enable row level security;

drop policy if exists "Anyone can insert leads" on public.leads;
create policy "Anyone can insert leads"
  on public.leads
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "Authenticated can read leads" on public.leads;
create policy "Authenticated can read leads"
  on public.leads
  for select
  to authenticated
  using (true);

create index if not exists leads_created_at_idx on public.leads (created_at desc);

create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('hourly_no_contact_enabled', 'false'::jsonb)
on conflict (key) do nothing;
`.trim();

const REQUIRED_TABLES = ["conversations", "messages", "leads", "app_settings"];

function getProjectRef() {
  const rawUrl = process.env.SUPABASE_URL;
  if (!rawUrl) return null;
  try {
    const host = new URL(rawUrl).hostname;
    return host.split(".")[0] || null;
  } catch {
    return null;
  }
}

async function runMigrationViaManagementApi(projectRef, accessToken) {
  const { data } = await axios.post(
    `https://api.supabase.com/v1/projects/${projectRef}/database/query`,
    { query: SETUP_SQL },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 60_000,
    }
  );
  return data;
}

async function tablesExist(db) {
  const results = await Promise.all(
    REQUIRED_TABLES.map(async (table) => {
      const { error } = await db.from(table).select("*").limit(1);
      return { table, ok: !error };
    })
  );
  return results;
}

async function main() {
  const rawUrl = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const accessToken = process.env.SUPABASE_ACCESS_TOKEN;
  const projectRef = getProjectRef();

  if (!rawUrl || !key) {
    console.error("❌ חסרים SUPABASE_URL או SUPABASE_SERVICE_KEY ב-.env");
    process.exit(1);
  }

  const url = new URL(rawUrl).origin;
  const db = createClient(url, key, { realtime: { transport: ws } });

  let status = await tablesExist(db);
  if (status.every((r) => r.ok)) {
    console.log("✅ כל הטבלאות כבר קיימות:", REQUIRED_TABLES.join(", "));
    return;
  }

  const missing = status.filter((r) => !r.ok).map((r) => r.table);
  console.log("ℹ️  טבלאות חסרות:", missing.join(", "));

  if (!accessToken || !projectRef) {
    console.log(
      "\n⚠️  חסר SUPABASE_ACCESS_TOKEN — העתק והרץ את ה-SQL הבא ב-Supabase → SQL Editor:\n"
    );
    console.log(SETUP_SQL);
    console.log(
      "\nאו הוסף SUPABASE_ACCESS_TOKEN ל-.env (מ-supabase.com/dashboard/account/tokens) והרץ שוב."
    );
    process.exit(0);
  }

  console.log(`🔧 יוצר סכמה בפרויקט ${projectRef}...`);
  try {
    await runMigrationViaManagementApi(projectRef, accessToken);
  } catch (err) {
    const msg =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err.message;
    console.error("❌ מיגרציה נכשלה:", msg);
    console.log("\nהרץ ידנית ב-SQL Editor:\n");
    console.log(SETUP_SQL);
    process.exit(1);
  }

  status = await tablesExist(db);
  const stillMissing = status.filter((r) => !r.ok).map((r) => r.table);
  if (stillMissing.length) {
    console.error("❌ אחרי המיגרציה עדיין חסרות:", stillMissing.join(", "));
    process.exit(1);
  }

  console.log("✅ Supabase הוגדר בהצלחה!");
  console.log("   טבלאות:", REQUIRED_TABLES.join(", "));
  console.log("\nהשלב הבא — משתמש לדשבורד:");
  console.log("   node scripts/create-auth-user.js <email> <password>");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
