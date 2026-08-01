const fs = require("fs");
const path = require("path");
const { getAppSetting, setAppSetting } = require("./appSettings");

const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.md");

const DEFAULT_WHATSAPP_STYLE = `**סגנון וואטסאפ ישראלי — חוקי ברזל:**
- משפט אחד קצר. מקסימום שניים רק אם חייבים.
- 5–15 מילים. לעולם יותר מ-20 מילים.
- ענייני וישיר — בלי הקדמות, בלי פסקאות, בלי רשימות, בלי כוכביות.
- כמו הודעה שחברה שולחת — לא כמו מייל או פרסומת.
- שאלה של הלקוח → תשובה ישירה, בלי "וואו" / "מעולה" / "מהמם" בהתחלה (אלא אם באמת מתאים).
- דוגמאות טובות: "249 ש״ח בחודש, בלי הקמה" / "רוצה לשמוע עוד?" / "הבנתי, בהצלחה ותודה 🙂"`;

function readDefaultKnowledge() {
  try {
    return fs.readFileSync(KNOWLEDGE_PATH, "utf-8");
  } catch {
    return "";
  }
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object") return deepClone(base);
  const out = deepClone(base);
  for (const [key, val] of Object.entries(patch)) {
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      out[key] &&
      typeof out[key] === "object" &&
      !Array.isArray(out[key])
    ) {
      out[key] = mergeDeep(out[key], val);
    } else if (val !== undefined) {
      out[key] = val;
    }
  }
  return out;
}

const DEFAULT_AI_AGENT_CONFIG = {
  agentName: "אליה",
  knowledgeBase: readDefaultKnowledge(),
  whatsappStyle: DEFAULT_WHATSAPP_STYLE,
  inbound: {
    openingTemplate:
      "{greeting}, אני אליה מצוות טורי 🙂 ראיתי שהשארת פרטים והתעניינת באפליקציה. מאיזה תחום אתה מגיע?",
    systemPromptOverride: "",
  },
  outbound: {
    firstMessageTemplate:
      "היי {name} מה שלומך ?\nהבנתי שאת בונת ציפורניים , זה נכון ?",
    systemPromptOverride: "",
  },
};

/**
 * שדות פרומפט ישנים שהוחלפו בבסיס הידע המשותף. נשארים בהגדרות שנשמרו בעבר
 * ולכן מנוקים בקריאה כדי שלא ידלפו בחזרה לממשק או לפרומפט.
 */
const LEGACY_SECTION_FIELDS = [
  "introduction",
  "goals",
  "conversationFlow",
  "toneAndStyle",
  "salesMethod",
  "hardRules",
];

function stripLegacyFields(config) {
  for (const section of ["inbound", "outbound"]) {
    if (!config[section] || typeof config[section] !== "object") continue;
    for (const field of LEGACY_SECTION_FIELDS) {
      delete config[section][field];
    }
  }
  return config;
}

let cachedConfig = null;
let cacheTime = 0;
const CACHE_MS = 3000;

function invalidateAiConfigCache() {
  cachedConfig = null;
  cacheTime = 0;
}

async function getAiAgentConfig() {
  const now = Date.now();
  if (cachedConfig && now - cacheTime < CACHE_MS) {
    return cachedConfig;
  }
  const stored = await getAppSetting("ai_agent_config", null);
  const merged = stripLegacyFields(
    stored && typeof stored === "object"
      ? mergeDeep(DEFAULT_AI_AGENT_CONFIG, stored)
      : deepClone(DEFAULT_AI_AGENT_CONFIG)
  );
  if (!merged.knowledgeBase?.trim()) {
    merged.knowledgeBase = readDefaultKnowledge();
  }
  cachedConfig = merged;
  cacheTime = now;
  return merged;
}

async function setAiAgentConfig(updates) {
  const current = await getAiAgentConfig();
  const merged = stripLegacyFields(mergeDeep(current, updates));
  merged.updatedAt = new Date().toISOString();
  await setAppSetting("ai_agent_config", merged);
  invalidateAiConfigCache();
  return merged;
}

async function resetAiAgentConfig() {
  const defaults = deepClone(DEFAULT_AI_AGENT_CONFIG);
  defaults.knowledgeBase = readDefaultKnowledge();
  defaults.updatedAt = new Date().toISOString();
  await setAppSetting("ai_agent_config", defaults);
  invalidateAiConfigCache();
  return defaults;
}

function getDefaultAiAgentConfig() {
  const defaults = deepClone(DEFAULT_AI_AGENT_CONFIG);
  defaults.knowledgeBase = readDefaultKnowledge();
  return defaults;
}

module.exports = {
  DEFAULT_AI_AGENT_CONFIG,
  DEFAULT_WHATSAPP_STYLE,
  getAiAgentConfig,
  setAiAgentConfig,
  resetAiAgentConfig,
  getDefaultAiAgentConfig,
  invalidateAiConfigCache,
  readDefaultKnowledge,
};
