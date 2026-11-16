const fs = require("fs");
const path = require("path");
const { getAppSetting, setAppSetting } = require("./appSettings");
const {
  DEFAULT_CONVERSATION_GUIDE,
  DEFAULT_INBOUND_PROMPT,
  DEFAULT_OUTBOUND_PROMPT,
  readDefaultInboundPrompt,
  readDefaultOutboundPrompt,
} = require("./promptDefaults");

const KNOWLEDGE_PATH = path.join(__dirname, "knowledge.md");

const DEFAULT_WHATSAPP_STYLE = `**סגנון וואטסאפ ישראלי — חוקי ברזל:**
- משפט אחד קצר. מקסימום שניים רק אם חייבים.
- 5–15 מילים. לעולם יותר מ-20 מילים.
- ענייני וישיר — בלי הקדמות, בלי פסקאות, בלי רשימות, בלי כוכביות.
- כמו הודעה שחברה שולחת — לא כמו מייל או פרסומת.
- שאלה של הלקוח → תשובה ישירה, בלי "וואו" / "מעולה" / "מהמם" בהתחלה (אלא אם באמת מתאים).
- דוגמאות טובות: "249 ₪ לחודש + מע״מ, והחודש הראשון 99" / "רוצה לשמוע עוד?" / "הבנתי, בהצלחה ותודה 🙂"`;

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
    prompt: DEFAULT_INBOUND_PROMPT,
    conversationGuide: DEFAULT_CONVERSATION_GUIDE,
    openingTemplate:
      "היי, כאן אליה מ-Tori 👋 איך אפשר לעזור?",
    systemPromptOverride: "",
  },
  outbound: {
    prompt: DEFAULT_OUTBOUND_PROMPT,
    conversationGuide: DEFAULT_CONVERSATION_GUIDE,
    firstMessageTemplate:
      "היי {name}, כאן אליה מ-Tori 👋 ראיתי שהשארת פרטים לגבי אפליקציה אישית לניהול תורים לעסק. אשמח להסביר בקצרה איך זה עובד — מה סוג העסק שלך?",
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

/**
 * הגדרות שנשמרו מהדשבורד או מאימון גוברות על הקבצים. כשהקבצים מתעדכנים
 * (למשל שינוי מחיר), עותק ישן ב-DB ימשיך לענות עם המידע הישן. סימני המחיר
 * הקודם מזהים עותק כזה, והוא מתרענן מהקבצים פעם אחת.
 */
const STALE_CONTENT_MARKERS = [/299\s*ש״?"?ח/u, /352\.82/];

function isStaleText(text) {
  const t = String(text || "");
  return STALE_CONTENT_MARKERS.some((re) => re.test(t));
}

function refreshStaleSections(config) {
  const refreshed = [];
  if (isStaleText(config.knowledgeBase)) {
    config.knowledgeBase = readDefaultKnowledge();
    refreshed.push("knowledgeBase");
  }
  const defaults = {
    inbound: readDefaultInboundPrompt(),
    outbound: readDefaultOutboundPrompt(),
  };
  for (const section of ["inbound", "outbound"]) {
    const s = config[section];
    if (!s || typeof s !== "object") continue;
    if (isStaleText(s.prompt)) {
      s.prompt = defaults[section];
      refreshed.push(`${section}.prompt`);
    }
    if (isStaleText(s.conversationGuide)) {
      s.conversationGuide = DEFAULT_CONVERSATION_GUIDE;
      refreshed.push(`${section}.conversationGuide`);
    }
    if (isStaleText(s.systemPromptOverride)) {
      s.systemPromptOverride = "";
      refreshed.push(`${section}.systemPromptOverride`);
    }
  }
  return refreshed;
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
  if (!merged.inbound?.prompt?.trim()) {
    merged.inbound.prompt = readDefaultInboundPrompt();
  }
  if (!merged.outbound?.prompt?.trim()) {
    merged.outbound.prompt = readDefaultOutboundPrompt();
  }
  const hadEmptyPrompt =
    stored &&
    typeof stored === "object" &&
    (!String(stored.inbound?.prompt || "").trim() ||
      !String(stored.outbound?.prompt || "").trim());
  const refreshed = stored && typeof stored === "object"
    ? refreshStaleSections(merged)
    : [];
  if (refreshed.length) {
    console.log(
      `♻️  הגדרות AI שמורות הכילו מידע ישן — רוענן מהקבצים: ${refreshed.join(", ")}`
    );
  }
  if (hadEmptyPrompt || refreshed.length) {
    merged.updatedAt = new Date().toISOString();
    await setAppSetting("ai_agent_config", merged);
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
  defaults.inbound.prompt = readDefaultInboundPrompt();
  defaults.outbound.prompt = readDefaultOutboundPrompt();
  defaults.updatedAt = new Date().toISOString();
  await setAppSetting("ai_agent_config", defaults);
  invalidateAiConfigCache();
  return defaults;
}

function getDefaultAiAgentConfig() {
  const defaults = deepClone(DEFAULT_AI_AGENT_CONFIG);
  defaults.knowledgeBase = readDefaultKnowledge();
  defaults.inbound.prompt = readDefaultInboundPrompt();
  defaults.outbound.prompt = readDefaultOutboundPrompt();
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
