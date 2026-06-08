/**
 * יוצר את טבלת app_settings ב-Supabase (הרץ פעם אחת).
 * שימוש: node scripts/setup-app-settings.js
 */
require("dotenv").config();
const axios = require("axios");
const ws = require("ws");
const { createClient } = require("@supabase/supabase-js");

const SQL = `
create table if not exists public.app_settings (
  key text primary key,
  value jsonb not null default 'null'::jsonb,
  updated_at timestamptz not null default now()
);

insert into public.app_settings (key, value)
values ('hourly_no_contact_enabled', 'false'::jsonb)
on conflict (key) do nothing;
`.trim();

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
    { query: SQL },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      timeout: 30_000,
    }
  );
  return data;
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

  const { error: probeErr } = await db.from("app_settings").select("key").limit(1);
  if (!probeErr) {
    console.log("✅ טבלת app_settings כבר קיימת");
    return;
  }

  if (probeErr.code !== "PGRST205") {
    console.error("❌", probeErr.message);
    process.exit(1);
  }

  if (!accessToken || !projectRef) {
    console.log("ℹ️  טבלת app_settings לא קיימת. הרץ את ה-SQL הבא ב-Supabase → SQL Editor:\n");
    console.log(SQL);
    process.exit(0);
  }

  console.log(`🔧 יוצר טבלת app_settings בפרויקט ${projectRef}...`);
  try {
    await runMigrationViaManagementApi(projectRef, accessToken);
  } catch (err) {
    const msg =
      err?.response?.data?.message ||
      err?.response?.data?.error ||
      err.message;
    console.error("❌ מיגרציה נכשלה:", msg);
    console.log("\nהרץ ידנית ב-SQL Editor:\n");
    console.log(SQL);
    process.exit(1);
  }

  const { error: verifyErr } = await db.from("app_settings").select("key").limit(1);
  if (verifyErr) {
    console.error("❌ הטבלה לא נראית אחרי המיגרציה:", verifyErr.message);
    process.exit(1);
  }

  console.log("✅ טבלת app_settings נוצרה בהצלחה");
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
