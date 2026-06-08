const PITCH_MESSAGE =
  "מהמם, אנחנו חברה שמספקת אפליקציה אישית לבונות ציפורניים 🙂 זה יכול לעניין אותך?";

const PITCH_MARKER = "זה יכול לעניין אותך";

function normalize(text) {
  return String(text || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isClearlyNegative(text) {
  const t = normalize(text);
  if (
    /^(לא|לאו|לא לא|no|nope)\b/.test(t) ||
    /\b(ממש לא|בכלל לא|לא בכלל|לא ממש|אף פעם לא)\b/.test(t) ||
    /^ממש\s+לא/.test(t)
  ) {
    return true;
  }
  return /לא מעוניין|לא רלוונטי|לא תודה|לא כרגע|בלי תודה|לא בשבילי|לא רוצה|לא נכון|זה לא נכון/i.test(
    t
  );
}

function isClearlyPositive(text) {
  const t = normalize(text);
  if (isClearlyNegative(t)) return false;
  return (
    /^(כן|כנ|נכון|בדיוק|כמובן|בטח|ברור|בהחלט|yes|yep|יאללה|מעולה|סבבה|אשכרה)\b/i.test(
      t
    ) || /\b(כן|נכון|מעניין|מעוניין)\b/i.test(t)
  );
}

function isNailTechConfirmation(text) {
  const t = normalize(text);
  if (isClearlyNegative(t)) return false;
  if (/ציפורנ|מניקור|סלון|לק ג|בונה|בונת|מטפלת|נייל/i.test(t)) {
    return true;
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

function botAskedNailTechQuestion(messages) {
  return messages.some(
    (m) =>
      (m.role === "bot" || m.role === "human_agent") &&
      /בונת ציפורניים|בונה ציפורניים/i.test(String(m.content || ""))
  );
}

/** חוסם הודעות מעקב / שאלה חוזרת על בונת ציפורניים */
function isNailTechReAsk(reply, messages) {
  if (!botAskedNailTechQuestion(messages)) return false;
  const t = normalize(reply);
  return (
    /בונת ציפורניים|בונה ציפורניים/i.test(t) &&
    /לוודא|זה נכון|כן או לא|רק ל/i.test(t)
  );
}

const NEGATIVE_GOODBYE = "הבנתי, סליחה על ההפרעה! בהצלחה ויום טוב 🙂";
const INTEREST_NUDGE =
  "אם זה מעניין אותך, נשמח לתאם שיחת טלפון קצרה ולהסביר הכל 🙂";

/**
 * שכבת ביטחון אחרי תשובת ה-AI. לעולם לא משתיקה את הבוט באמצע שיחה —
 * אם ה-AI חזר ריק או חזר על השאלה האסורה, מחליפה בתשובה ענייניות שמקדמת את השיחה.
 */
function sanitizeProactiveReply(reply, messages, lastUser) {
  const clean = String(reply || "").trim();

  // תשובה ריקה מה-AI — אל תשתיקי את הבוט, החזירי תשובה הולמת לפי ההקשר.
  if (!clean) {
    if (isClearlyNegative(lastUser)) return NEGATIVE_GOODBYE;
    if (!botAlreadyPitched(messages) && isNailTechConfirmation(lastUser)) {
      return PITCH_MESSAGE;
    }
    return INTEREST_NUDGE;
  }

  if (!isNailTechReAsk(clean, messages)) return clean;

  // ה-AI ניסה לשאול שוב "את בונה ציפורניים?" — אסור. מחליפים בתשובה נכונה.
  if (isClearlyNegative(lastUser)) {
    return NEGATIVE_GOODBYE;
  }
  if (!botAlreadyPitched(messages)) {
    return PITCH_MESSAGE;
  }
  return INTEREST_NUDGE;
}

/** הבוט עונה רק אם ההודעה האחרונה בשיחה היא מהלקוחה */
function shouldReplyToInbound(allMessages, incomingText) {
  const thread = allMessages.filter((m) =>
    ["user", "bot", "human_agent"].includes(m.role)
  );
  const last = thread[thread.length - 1];
  if (!last || last.role !== "user") return false;
  return String(last.content || "").trim() === String(incomingText || "").trim();
}

/**
 * קובע עדכון סטטוס ליד לפי תשובת הלקוחה.
 */
function detectLeadStatus(messages, lastUser) {
  const pitched = botAlreadyPitched(messages);
  const askedNailTech = botAskedNailTechQuestion(messages);

  if (!pitched && askedNailTech) {
    if (isClearlyNegative(lastUser)) return "not_relevant";
    if (isNailTechConfirmation(lastUser)) return "active_conversation";
    return null;
  }

  if (pitched) {
    if (isClearlyPositive(lastUser)) return "relevant";
    if (isClearlyNegative(lastUser)) return "not_relevant";
  }

  return null;
}

module.exports = {
  detectLeadStatus,
  sanitizeProactiveReply,
  shouldReplyToInbound,
  PITCH_MESSAGE,
  isClearlyNegative,
  isClearlyPositive,
};
