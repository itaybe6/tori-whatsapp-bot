/**
 * יוצר משתמש התחברות לדשבורד (ללא הרשמה ציבורית).
 * שימוש: node scripts/create-auth-user.js <email> <password>
 */
require("dotenv").config();

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;
const email = process.argv[2];
const password = process.argv[3];

if (!url || !serviceKey) {
  console.error("❌ חסר SUPABASE_URL או SUPABASE_SERVICE_KEY ב-.env");
  process.exit(1);
}
if (!email || !password) {
  console.error("שימוש: node scripts/create-auth-user.js <email> <password>");
  process.exit(1);
}

async function main() {
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
    }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.msg || data.message || data.error_description || res.statusText;
    if (
      res.status === 422 &&
      /already|registered|exists/i.test(String(msg))
    ) {
      console.log(`ℹ️  המשתמש ${email} כבר קיים`);
      return;
    }
    console.error(`❌ יצירת משתמש נכשלה: ${msg}`);
    process.exit(1);
  }

  console.log(`✅ נוצר משתמש: ${email}`);
  console.log(`   id: ${data.id || "—"}`);
}

main().catch((err) => {
  console.error("❌", err.message || err);
  process.exit(1);
});
