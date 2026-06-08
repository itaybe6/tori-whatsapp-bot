const fs = require("fs");
const path = require("path");
const { requireClient } = require("./db");

const SETTINGS_PATH = path.join(__dirname, "..", "data", "app-settings.json");

function isMissingSettingsTable(err) {
  const code = String(err?.code || "");
  const msg = String(err?.message || err || "");
  return (
    code === "PGRST205" ||
    (msg.includes("app_settings") &&
      (msg.includes("does not exist") ||
        msg.includes("schema cache") ||
        msg.includes("Could not find the table")))
  );
}

function readFileSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeFileSettings(all) {
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(all, null, 2), "utf-8");
}

async function readSupabaseSetting(key) {
  const db = requireClient();
  const { data, error } = await db
    .from("app_settings")
    .select("value")
    .eq("key", key)
    .maybeSingle();
  if (error) throw error;
  if (!data) return undefined;
  return data.value;
}

async function writeSupabaseSetting(key, value) {
  const db = requireClient();
  const { error } = await db.from("app_settings").upsert(
    {
      key,
      value,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key" }
  );
  if (error) throw error;
}

async function getAppSetting(key, defaultValue = null) {
  try {
    const value = await readSupabaseSetting(key);
    if (value !== undefined) return value;
  } catch (err) {
    if (!isMissingSettingsTable(err)) {
      console.warn(`⚠️ קריאת הגדרה ${key} מ-Supabase: ${err.message}`);
    }
  }

  const file = readFileSettings();
  if (Object.prototype.hasOwnProperty.call(file, key)) {
    return file[key];
  }
  return defaultValue;
}

async function setAppSetting(key, value) {
  const file = readFileSettings();
  file[key] = value;
  writeFileSettings(file);

  try {
    await writeSupabaseSetting(key, value);
  } catch (err) {
    if (isMissingSettingsTable(err)) return;
    console.warn(`⚠️ שמירת הגדרה ${key} ב-Supabase: ${err.message}`);
  }
}

module.exports = {
  getAppSetting,
  setAppSetting,
  SETTINGS_PATH,
};
