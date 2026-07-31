const { getAppSetting, setAppSetting } = require("./appSettings");
const { getLeadsByStatus, updateLead } = require("./db");
const { getFirstLeadMessage } = require("./agent");
const { sendProactiveMessage } = require("./whatsapp");

const HOUR_START = 10;
const HOUR_END = 16;
const POLL_MS = 60_000;

function getIsraelTimeParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);

  const pick = (type) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = parseInt(pick("hour"), 10);
  const minute = parseInt(pick("minute"), 10);
  const slotKey = `${pick("year")}-${pick("month")}-${pick("day")}T${String(hour).padStart(2, "0")}`;

  return { hour, minute, slotKey };
}

function isWithinSendingWindow(hour) {
  return hour >= HOUR_START && hour <= HOUR_END;
}

function createSendNoContactOutreach(deps) {
  const {
    normalizePhone,
    canSendFirstMessageToLead,
    upsertConversation,
    markConversationProactive,
    saveMessage,
    getFirstLeadTemplateOptions,
    sendOpening,
    conversations,
  } = deps;

  return async function sendNoContactOutreach(lead) {
    const phone = normalizePhone(lead.phone);
    if (!phone) {
      return { skipped: true, reason: "invalid_phone" };
    }

    if (canSendFirstMessageToLead(lead)) {
      const messageName = String(lead.message_name || "").trim();
      if (!messageName) {
        return { skipped: true, reason: "no_message_name" };
      }

      const text = await getFirstLeadMessage(messageName);
      await upsertConversation(phone, messageName);
      await markConversationProactive(phone);
      await sendProactiveMessage(phone, messageName, getFirstLeadTemplateOptions());
      await saveMessage(phone, "bot", text);
      await updateLead(lead.id, { status: "message_sent" });
      conversations.set(phone, [{ role: "model", parts: [{ text }] }]);
      return { skipped: false, phone, message: text };
    }

    const name = lead.message_name || lead.name || "";
    const result = await sendOpening(phone, name);
    if (!result.skipped) {
      await updateLead(lead.id, { status: "message_sent" });
    }
    return result;
  };
}

function startHourlyNoContactScheduler(deps) {
  const sendNoContactOutreach = createSendNoContactOutreach(deps);
  let tickInFlight = false;

  async function tickHourlyNoContact() {
    if (tickInFlight) return;
    tickInFlight = true;

    try {
      const enabled = await getAppSetting("hourly_no_contact_enabled", false);
      if (enabled !== true) return;

      const { hour, slotKey } = getIsraelTimeParts();
      if (!isWithinSendingWindow(hour)) return;

      const lastSlot = await getAppSetting("hourly_no_contact_last_slot", null);
      if (lastSlot === slotKey) return;

      const leads = await getLeadsByStatus("no_contact");
      if (!leads.length) {
        await setAppSetting("hourly_no_contact_last_slot", slotKey);
        return;
      }

      for (const lead of leads) {
        try {
          const result = await sendNoContactOutreach(lead);
          if (result.skipped) {
            if (result.reason === "has_messages") {
              await updateLead(lead.id, { status: "message_sent" });
              continue;
            }
            if (
              result.reason === "no_message_name" ||
              result.reason === "invalid_phone"
            ) {
              continue;
            }
            continue;
          }

          await setAppSetting("hourly_no_contact_last_slot", slotKey);
          console.log(
            `⏰ שליחה שעתית לליד ללא קשר: ${lead.business || lead.name} (${lead.phone})`
          );
          return;
        } catch (err) {
          console.error(
            `❌ שליחה שעתית נכשלה ל-${lead.phone}:`,
            err.message
          );
          return;
        }
      }

      await setAppSetting("hourly_no_contact_last_slot", slotKey);
    } catch (err) {
      console.error("❌ hourlyNoContact:", err.message);
    } finally {
      tickInFlight = false;
    }
  }

  setInterval(tickHourlyNoContact, POLL_MS);

  return { tickHourlyNoContact };
}

module.exports = {
  startHourlyNoContactScheduler,
  getIsraelTimeParts,
  isWithinSendingWindow,
  HOUR_START,
  HOUR_END,
};
