const axios = require("axios");
const { enforceRtl } = require("./rtlText");

const BASE_URL = `https://graph.facebook.com/v21.0`;

function authHeaders() {
  return {
    Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
    "Content-Type": "application/json",
  };
}

async function postWhatsApp(payload) {
  const url = `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`;
  try {
    const res = await axios.post(url, payload, { headers: authHeaders() });
    return res.data;
  } catch (err) {
    const fb = err.response?.data?.error;
    console.error(
      `❌ שגיאת שליחה ל-${payload.to}:`,
      err.response?.data || err.message
    );
    if (
      fb?.code === 190 ||
      /session has expired|invalid.*token/i.test(fb?.message || "")
    ) {
      console.error(
        "💡 קוד 190 / Authentication: ה-WHATSAPP_TOKEN ב-.env כנראה פג תוקף או בוטל. צור Access Token חדש ב-Meta (WhatsApp → API Setup) והחלף את WHATSAPP_TOKEN."
      );
    }
    if (fb?.code === 131047 || fb?.code === 63016) {
      console.error(
        "💡 חלון 24 שעות סגור — לשליחה יזומה חייב template מאושר (WHATSAPP_OPENING_TEMPLATE ב-.env)."
      );
    }
    const detail =
      fb?.error_user_msg || fb?.message || err.message || "שגיאת שליחה";
    throw new Error(detail);
  }
}

// וואטסאפ מסתיר את חיווי ההקלדה אחרי 25 שניות או ברגע שנשלחת תשובה — מה שקורה קודם.
const TYPING_REFRESH_MS =
  Number(process.env.WHATSAPP_TYPING_REFRESH_MS) || 20_000;
const TYPING_MAX_MS = Number(process.env.WHATSAPP_TYPING_MAX_MS) || 60_000;

/**
 * מסמן את ההודעה הנכנסת כנקראה ומציג "מקליד…" ללקוח.
 * לא זורק — כישלון בחיווי לא אמור למנוע את שליחת התשובה עצמה.
 */
async function sendTypingIndicator(messageId) {
  if (!messageId) return false;
  const url = `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`;
  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
        typing_indicator: { type: "text" },
      },
      { headers: authHeaders() }
    );
    return true;
  } catch (err) {
    const fb = err.response?.data?.error;
    console.warn(`⚠️ חיווי הקלדה נכשל: ${fb?.message || err.message}`);
    return false;
  }
}

/**
 * מציג "מקליד…" ומרענן אותו כל עוד התשובה בהכנה, עד תקרה של TYPING_MAX_MS.
 * מחזיר פונקציית עצירה — חובה לקרוא לה בכל מסלול יציאה.
 */
function startTypingIndicator(messageId) {
  if (!messageId) return () => {};

  let stopped = false;
  let timer = null;
  const deadline = Date.now() + TYPING_MAX_MS;

  const refresh = async () => {
    if (stopped) return;
    await sendTypingIndicator(messageId);
    if (stopped || Date.now() + TYPING_REFRESH_MS >= deadline) return;
    timer = setTimeout(refresh, TYPING_REFRESH_MS);
    timer.unref?.();
  };
  refresh();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

async function sendMessage(to, text) {
  // התיקון חל רק על מה שנשלח לוואטסאפ — הטקסט שנשמר ב-DB נשאר נקי מסימני כיוון.
  const data = await postWhatsApp({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: enforceRtl(text) },
  });
  const msg = data.messages?.[0];
  console.log(
    `✅ נשלח ל-${to}${msg?.id ? ` (${msg.message_status || "sent"})` : ""}`
  );
  return data;
}

/**
 * שליחת template — חובה לשיחה יזומה (business-initiated) מחוץ לחלון 24 שעות.
 */
async function sendTemplateMessage(to, options = {}) {
  const templateName =
    options.templateName ||
    process.env.WHATSAPP_OPENING_TEMPLATE ||
    "hello_world";
  const languageCode =
    options.languageCode ||
    process.env.WHATSAPP_OPENING_TEMPLATE_LANG ||
    "en_US";
  const useNameVar =
    options.useNameVar ??
    process.env.WHATSAPP_OPENING_TEMPLATE_HAS_NAME === "true";

  const template = {
    name: templateName,
    language: { code: languageCode },
  };

  if (useNameVar && options.name) {
    const displayName = String(options.name).trim();
    if (displayName) {
      template.components = [
        {
          type: "body",
          parameters: [{ type: "text", text: displayName }],
        },
      ];
    }
  }

  const data = await postWhatsApp({
    messaging_product: "whatsapp",
    to,
    type: "template",
    template,
  });
  const msg = data.messages?.[0];
  console.log(
    `✅ template "${templateName}" נשלח ל-${to}${msg?.message_status ? ` (${msg.message_status})` : ""}`
  );
  return data;
}

/** שליחה יזומה ראשונה — תמיד דרך template (Live mode). */
async function sendProactiveMessage(to, name, options = {}) {
  return sendTemplateMessage(to, { name, ...options });
}

module.exports = {
  sendMessage,
  sendTemplateMessage,
  sendProactiveMessage,
  sendTypingIndicator,
  startTypingIndicator,
};
