/**
 * בודק חיבור ל-Supabase. שימוש: node scripts/check-supabase.js
 */
require("dotenv").config();
const { checkConnection, wrapDbError } = require("../src/db");

async function main() {
  const url = process.env.SUPABASE_URL || "";
  const key = process.env.SUPABASE_SERVICE_KEY || "";

  if (!url || !key) {
    console.error("❌ חסרים SUPABASE_URL או SUPABASE_SERVICE_KEY ב-.env");
    process.exit(1);
  }

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    console.error("❌ SUPABASE_URL לא תקין:", url);
    process.exit(1);
  }

  console.log(`🔍 בודק חיבור ל-${host} ...`);

  try {
    await checkConnection();
    console.log("✅ Supabase מחובר בהצלחה!");
  } catch (err) {
    console.error("❌", wrapDbError(err).message);
    process.exit(1);
  }
}

main();
