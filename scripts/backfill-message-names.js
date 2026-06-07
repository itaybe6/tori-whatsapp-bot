/**
 * מאתחל message_name לכל הלידים הקיימים. שימוש: node scripts/backfill-message-names.js
 */
require("dotenv").config();
const { backfillMessageNames } = require("../src/db");

async function main() {
  console.log("🔄 מאתחל שמות לשליחת הודעה…");
  const updated = await backfillMessageNames();
  console.log(`✅ עודכנו ${updated} לידים`);
}

main().catch((err) => {
  console.error("❌", err.message);
  process.exit(1);
});
