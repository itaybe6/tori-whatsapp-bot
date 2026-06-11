/**
 * בונה את הדשבורד לפריסה סטטית (Vercel וכו').
 * יוצר public/index.html + public/config.js עם כתובת ה-API.
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const outDir = path.join(root, "public");
const apiBase =
  process.env.TORI_API_BASE ||
  "https://tori-whatsapp-bot-production.up.railway.app";
const supabaseUrl = process.env.SUPABASE_URL || "";
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || "";

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(
  path.join(root, "dashboard.html"),
  path.join(outDir, "index.html")
);
fs.writeFileSync(
  path.join(outDir, "config.js"),
  [
    `window.TORI_API_BASE = ${JSON.stringify(apiBase)};`,
    `window.SUPABASE_URL = ${JSON.stringify(supabaseUrl)};`,
    `window.SUPABASE_ANON_KEY = ${JSON.stringify(supabaseAnonKey)};`,
    "",
  ].join("\n")
);

console.log(`✅ Dashboard built → ${outDir}`);
console.log(`   API: ${apiBase}`);
if (!supabaseUrl || !supabaseAnonKey) {
  console.warn("⚠️  חסר SUPABASE_URL או SUPABASE_ANON_KEY — מסך התחברות לא יעבוד");
}
