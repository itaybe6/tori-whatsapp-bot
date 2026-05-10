const axios = require("axios");

const BASE_URL = `https://graph.facebook.com/v21.0`;

async function sendMessage(to, text) {
  const url = `${BASE_URL}/${process.env.PHONE_NUMBER_ID}/messages`;

  try {
    await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
    console.log(`✅ נשלח ל-${to}`);
  } catch (err) {
    const fb = err.response?.data?.error;
    console.error(`❌ שגיאת שליחה ל-${to}:`, err.response?.data || err.message);
    if (fb?.code === 190 || /session has expired|invalid.*token/i.test(fb?.message || "")) {
      console.error(
        "💡 קוד 190 / Authentication: ה-WHATSAPP_TOKEN ב-.env כנראה פג תוקף או בוטל. צור Access Token חדש ב-Meta (WhatsApp → API Setup) והחלף את WHATSAPP_TOKEN."
      );
    }
  }
}

module.exports = { sendMessage };
