const axios = require("axios");

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
    throw err;
  }
}

async function sendMessage(to, text) {
  const data = await postWhatsApp({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body: text },
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
    const firstName = String(options.name).trim().split(/\s+/)[0];
    if (firstName) {
      template.components = [
        {
          type: "body",
          parameters: [{ type: "text", text: firstName }],
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

module.exports = { sendMessage, sendTemplateMessage, sendProactiveMessage };
