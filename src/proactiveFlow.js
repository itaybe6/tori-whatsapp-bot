const PITCH_MESSAGE =
  "מהמם, אנחנו חברה שמספקת אפליקציה אישית לבונות ציפורניים 🙂 זה יכול לעניין אותך?";

const PITCH_MARKER = "זה יכול לעניין אותך";

/** השהייה קצרה לפני תשובה — מרגיש יותר אנושי (2–4.5 שניות) */
function getProactiveReplyDelayMs() {
  const min = Number(process.env.PROACTIVE_REPLY_DELAY_MIN_MS) || 2000;
  const max = Number(process.env.PROACTIVE_REPLY_DELAY_MAX_MS) || 4500;
  return min + Math.floor(Math.random() * Math.max(0, max - min));
}

function normalize(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isClearlyNegative(text) {
  const t = normalize(text);
  return (
    /^(לא|לאו|לא לא|no|nope)\b/.test(t) ||
    /לא מעוניין|לא רלוונטי|לא תודה|לא כרגע|בלי תודה|לא בשבילי|לא רוצה/i.test(
      t
    )
  );
}

function isClearlyPositive(text) {
  const t = normalize(text);
  if (isClearlyNegative(t)) return false;
  return (
    /^(כן|כנ|נכון|בדיוק|כמובן|בטח|ברור|ממש|בהחלט|yes|yep|יאללה|אשכרה|מעולה|סבבה|אשכרה)/i.test(
      t
    ) || /\b(כן|נכון|מעניין|מעוניין)\b/i.test(t)
  );
}

function isNailTechConfirmation(text) {
  const t = normalize(text);
  if (isClearlyNegative(t) && !/ציפורנ|מניקור|לק|סלון/.test(t)) {
    return false;
  }
  if (/ציפורנ|מניקור|סלון|לק ג|בונה|בונת|מטפלת|נייל/i.test(t)) {
    return !/^לא\b/.test(t);
  }
  return isClearlyPositive(t);
}

function botAlreadyPitched(messages) {
  return messages.some(
    (m) =>
      (m.role === "bot" || m.role === "human_agent") &&
      String(m.content || "").includes(PITCH_MARKER)
  );
}

/**
 * מחזיר תשובה לשיחה יזומה + עדכון סטטוס ליד (אופציונלי).
 */
function getProactiveReply(messages) {
  const userMsgs = messages.filter((m) => m.role === "user");
  const lastUser = userMsgs[userMsgs.length - 1]?.content || "";
  const pitched = botAlreadyPitched(messages);

  if (!pitched) {
    if (isNailTechConfirmation(lastUser)) {
      return {
        reply: PITCH_MESSAGE,
        leadStatus: "active_conversation",
      };
    }
    if (isClearlyNegative(lastUser)) {
      return {
        reply: "הבנתי, תודה על התשובה! יום טוב 🙂",
        leadStatus: "not_relevant",
      };
    }
    return {
      reply: "רק לוודא — את בונה ציפורניים? כן או לא?",
    };
  }

  if (isClearlyPositive(lastUser)) {
    return {
      reply: "מעולה! נציג יחזור אליך בהקדם עם כל הפרטים 🙏",
      leadStatus: "relevant",
    };
  }
  if (isClearlyNegative(lastUser)) {
    return {
      reply: "בסדר גמור, תודה על הזמן! יום טוב 🙂",
      leadStatus: "not_relevant",
    };
  }

  return {
    reply: "זה יכול לעניין אותך? כן או לא?",
  };
}

module.exports = {
  getProactiveReply,
  getProactiveReplyDelayMs,
  PITCH_MESSAGE,
};
