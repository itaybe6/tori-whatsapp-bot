/**
 * תיקון כיוון טקסט דו-כיווני (bidi) להודעות וואטסאפ.
 *
 * וואטסאפ קובע את כיוון ההצגה של כל שורה לפי התו החזק הראשון בה. שורה בעברית
 * שמתחילה במילה לועזית — למשל "Tori מספקת אפליקציה…" — נחשבת שורת LTR,
 * והמילים מוצגות בסדר שבור (המילה הלועזית קופצת לסוף השורה).
 *
 * תו RLM (Right-to-Left Mark) בתחילת השורה מקבע אותה כ-RTL. הוא ברוחב אפס
 * ואינו נראה ללקוח. משם ואילך אלגוריתם ה-bidi מסדר נכון גם מילים לועזיות
 * וגם פיסוק שמשולבים באמצע המשפט.
 */
const RLM = "\u200F";

const HEBREW = /[\u0590-\u05FF]/;
// הבוט מדבר עברית ואנגלית בלבד, ולכן די בבדיקת שתי הקבוצות האלה.
const STRONG_DIRECTIONAL = /[A-Za-z\u0590-\u05FF]/;

function lineNeedsRtlMark(line) {
  if (line.startsWith(RLM)) return false;
  if (!HEBREW.test(line)) return false;
  const firstStrong = line.match(STRONG_DIRECTIONAL);
  return Boolean(firstStrong) && !HEBREW.test(firstStrong[0]);
}

/**
 * מוסיף RLM בתחילת כל שורה עברית שמתחילה בתו לועזי.
 * שורות שכבר מתחילות בעברית, או שאין בהן עברית כלל, נשארות ללא שינוי.
 */
function enforceRtl(text) {
  const raw = String(text ?? "");
  if (!HEBREW.test(raw)) return raw;
  return raw
    .split("\n")
    .map((line) => (lineNeedsRtlMark(line) ? RLM + line : line))
    .join("\n");
}

module.exports = { enforceRtl, RLM };
