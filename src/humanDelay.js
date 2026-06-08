/**
 * דיליי אנושי לפני שליחת תשובה — קריאה + הקלדה, כמו בן אדם בוואטסאפ.
 */
function getHumanReplyDelayMs(userText, replyText) {
  const readMin = Number(process.env.HUMAN_DELAY_READ_MIN_MS) || 2000;
  const readMax = Number(process.env.HUMAN_DELAY_READ_MAX_MS) || 4500;
  const msPerChar = Number(process.env.HUMAN_DELAY_MS_PER_CHAR) || 48;
  const min = Number(process.env.HUMAN_DELAY_MIN_MS) || 3000;
  const max = Number(process.env.HUMAN_DELAY_MAX_MS) || 14000;

  const userLen = String(userText || "").length;
  const replyLen = String(replyText || "").length;

  const readRatio = 0.35 + Math.random() * 0.55;
  const readSpan = Math.max(0, readMax - readMin);
  const readTime = readMin + Math.min(userLen * 18, readSpan) * readRatio;

  const typingFactor = 0.7 + Math.random() * 0.55;
  const typeTime = replyLen * msPerChar * typingFactor;

  const thinkingPause = Math.random() < 0.3 ? 600 + Math.random() * 1800 : 0;

  return Math.round(Math.min(max, Math.max(min, readTime + typeTime + thinkingPause)));
}

module.exports = { getHumanReplyDelayMs };
