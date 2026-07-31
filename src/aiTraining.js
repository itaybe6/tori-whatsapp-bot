const crypto = require("crypto");
const { setAiAgentConfig, getAiAgentConfig } = require("./aiAgentConfig");
const {
  getOpeningMessage,
  getFirstLeadMessage,
  previewInboundPrompt,
  previewOutboundPrompt,
  generateTrainingInboundReply,
  generateTrainingOutboundReply,
  regenerateAgentReplyWithTrainerNote,
  ruleBasedRevisionFallback,
  isGeminiQuotaError,
  formatGeminiUserError,
} = require("./agent");
const { completeJson } = require("./llm");

const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [id, session] of sessions.entries()) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function getSession(sessionId) {
  pruneSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(sessionId);
    return null;
  }
  return session;
}

function parseJsonFromModel(text) {
  const s = String(text || "").trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1].trim() : s;
  try {
    if (fenced) return JSON.parse(raw);
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(raw.slice(start, end + 1));
    }
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(
      "לא ניתן לפרסר תשובת המודל: " + (err.message || "JSON לא תקין")
    );
  }
}

async function callModelJson(prompt, maxOutputTokens = 8192) {
  const text = await completeJson({ userPrompt: prompt, maxOutputTokens });
  return parseJsonFromModel(text);
}

function parseInlineTrainerNote(text) {
  const trimmed = String(text || "").trim();
  const match = trimmed.match(/^\*\s*([\s\S]+?)\s*\*$/);
  if (!match) return null;
  const note = match[1].trim();
  return note || null;
}

function conversationMessagesForAgent(messages) {
  const revisedByIndex = new Map();
  for (const m of messages) {
    if (
      m.isRevisedPreview &&
      typeof m.replacesMessageIndex === "number" &&
      m.replacesMessageIndex >= 0
    ) {
      revisedByIndex.set(m.replacesMessageIndex, m.content);
    }
  }

  const out = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (
      m.role === "trainer_note" ||
      m.isAcknowledgment ||
      m.isRevisedPreview
    ) {
      continue;
    }
    if (m.role === "user") {
      out.push(m);
      continue;
    }
    if (m.role === "bot" && !m.isAcknowledgment) {
      const content = revisedByIndex.has(i)
        ? revisedByIndex.get(i)
        : m.content;
      out.push({ ...m, content });
    }
  }
  return out;
}

function getLastAgentMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (
      m.role === "bot" &&
      !m.isAcknowledgment &&
      !m.isRevisedPreview
    ) {
      return m;
    }
  }
  return null;
}

function formatContextBeforeIndex(messages, agentName, endIndexExclusive) {
  const lines = [];
  for (let i = 0; i < endIndexExclusive; i++) {
    const m = messages[i];
    if (m.role === "trainer_note") {
      lines.push(`מאמן (הערה): ${m.content}`);
    } else if (m.role === "bot" && m.isAcknowledgment) {
      continue;
    } else if (m.role === "bot" && m.isRevisedPreview) {
      lines.push(`${agentName}: ${m.content} (מתוקנת)`);
    } else if (m.role === "bot") {
      lines.push(`${agentName}: ${m.content}`);
    } else if (m.role === "user") {
      lines.push(`לקוח: ${m.content}`);
    }
  }
  return lines.join("\n");
}

function formatTranscriptForSummary(session, agentName) {
  return session.messages
    .map((m) => {
      if (m.role === "trainer_note") {
        return `מאמן (הערה על הודעה): ${m.content}`;
      }
      if (m.role === "bot" && m.isAcknowledgment) {
        return "מערכת (אישור הבנה): " + m.content;
      }
      if (m.role === "bot" && m.isRevisedPreview) {
        return `${agentName || "נציג"} (מתוקנת): ${m.content}`;
      }
      if (m.role === "bot") {
        return `${agentName || "נציג"}: ${m.content}`;
      }
      if (m.role === "user") {
        return "לקוח (מאמן): " + m.content;
      }
      return String(m.content || "");
    })
    .join("\n");
}

function formatFeedbackForSummary(session) {
  return session.feedback
    .map((f, i) => {
      let line = `${i + 1}. ${f.text}`;
      if (f.relatedMessageContent) {
        line += ` [על הודעת הנציג: "${f.relatedMessageContent}"]`;
      }
      if (f.type === "inline") {
        line += " (הערה בשיחה עם *...*)";
      }
      return line;
    })
    .join("\n");
}

function localNoteAcknowledgment(note, quotaLimited = false) {
  const n = String(note || "").trim();
  const base =
    n.length > 100 ? `הבנתי. ${n.slice(0, 97)}…` : `הבנתי. ${n}`;
  if (quotaLimited) {
    return `${base} (מכסת API מלאה — תשובה מתוקנת בסיסית מקומית)`;
  }
  return base;
}

async function handleInlineTrainerNote(session, noteText) {
  const lastAgent = getLastAgentMessage(session.messages);
  const relatedContent = lastAgent?.content || "";
  const relatedIndex = lastAgent
    ? session.messages.indexOf(lastAgent)
    : -1;

  const entry = {
    id: crypto.randomUUID(),
    text: noteText,
    ts: Date.now(),
    type: "inline",
    afterMessageCount: session.messages.length,
    relatedMessageIndex: relatedIndex,
    relatedMessageContent: relatedContent,
  };
  session.feedback.push(entry);

  const priorForRegen =
    relatedIndex >= 0
      ? conversationMessagesForAgent(session.messages.slice(0, relatedIndex))
      : [];

  let ack = localNoteAcknowledgment(noteText);
  let revised = relatedContent;
  let quotaWarning = null;

  if (relatedIndex >= 0 && relatedContent) {
    try {
      revised = await regenerateAgentReplyWithTrainerNote(
        session.mode,
        priorForRegen,
        relatedContent,
        noteText,
        session.agentName
      );
    } catch (err) {
      if (isGeminiQuotaError(err)) {
        revised = ruleBasedRevisionFallback(priorForRegen, relatedContent);
        ack = localNoteAcknowledgment(noteText, true);
        quotaWarning = formatGeminiUserError(err);
      } else {
        throw err;
      }
    }
  }

  session.messages.push(
    {
      role: "trainer_note",
      content: noteText,
      ts: Date.now(),
      relatedMessageIndex: relatedIndex,
      relatedMessageContent: relatedContent,
    },
    {
      role: "bot",
      content: ack,
      ts: Date.now(),
      isAcknowledgment: true,
    }
  );

  if (relatedIndex >= 0 && revised) {
    session.messages.push({
      role: "bot",
      content: revised,
      ts: Date.now(),
      isRevisedPreview: true,
      replacesMessageIndex: relatedIndex,
      relatedNote: noteText,
    });
  }

  return {
    reply: ack,
    revisedReply: revised !== relatedContent ? revised : null,
    replyType: "inline_note",
    quotaWarning,
    messages: session.messages,
    feedback: session.feedback,
  };
}

async function startTrainingSession(mode) {
  if (mode !== "inbound" && mode !== "outbound") {
    throw new Error("mode חייב inbound או outbound");
  }

  pruneSessions();
  const config = await getAiAgentConfig();
  const agentName = config.agentName || "אליה";

  const session = {
    id: crypto.randomUUID(),
    mode,
    agentName,
    messages: [],
    feedback: [],
    summary: null,
    createdAt: Date.now(),
  };

  let opening = "";
  if (mode === "inbound") {
    opening = await getOpeningMessage("דוד");
  } else {
    opening = await getFirstLeadMessage("שרה");
  }

  if (opening) {
    session.messages.push({
      role: "bot",
      content: opening,
      ts: Date.now(),
    });
  }

  sessions.set(session.id, session);
  return {
    sessionId: session.id,
    mode: session.mode,
    agentName: session.agentName,
    openingMessage: opening,
    messages: session.messages,
    feedback: session.feedback,
  };
}

async function trainingChat(sessionId, userMessage) {
  const session = getSession(sessionId);
  if (!session) throw new Error("סשן אימון לא נמצא או שפג תוקפו");

  const text = String(userMessage || "").trim();
  if (!text) throw new Error("חסרה הודעה");

  session.summary = null;

  const inlineNote = parseInlineTrainerNote(text);
  if (inlineNote) {
    return await handleInlineTrainerNote(session, inlineNote);
  }

  const prior = conversationMessagesForAgent(session.messages);
  let reply;
  if (session.mode === "inbound") {
    reply = await generateTrainingInboundReply(prior, text);
  } else {
    reply = await generateTrainingOutboundReply(prior, text);
  }

  if (!reply) throw new Error("הנציג לא החזיר תשובה");

  session.messages.push(
    { role: "user", content: text, ts: Date.now() },
    { role: "bot", content: reply, ts: Date.now() }
  );

  return {
    reply,
    replyType: "chat",
    messages: session.messages,
    feedback: session.feedback,
  };
}

function addTrainingFeedback(sessionId, note) {
  const session = getSession(sessionId);
  if (!session) throw new Error("סשן אימון לא נמצא או שפג תוקפו");

  const text = String(note || "").trim();
  if (!text) throw new Error("חסרה הערה");

  const entry = {
    id: crypto.randomUUID(),
    text,
    ts: Date.now(),
    afterMessageCount: session.messages.length,
  };
  session.feedback.push(entry);
  session.summary = null;

  return { feedback: session.feedback };
}

async function summarizeTrainingSession(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error("סשן אימון לא נמצא או שפג תוקפו");

  if (!session.messages.length && !session.feedback.length) {
    throw new Error("אין מספיק תוכן לסיכום — התחל שיחה או הוסף הערות");
  }

  const currentPrompt =
    session.mode === "inbound"
      ? await previewInboundPrompt()
      : await previewOutboundPrompt();

  const transcript = formatTranscriptForSummary(session, session.agentName);
  const feedbackLines = formatFeedbackForSummary(session);

  const modeLabel =
    session.mode === "inbound" ? "הודעות נכנסות (דף נחיתה)" : "הודעות יוצאות (לידים)";

  const promptMax = 12000;
  const trimmedPrompt =
    currentPrompt.length > promptMax
      ? currentPrompt.slice(0, promptMax) + "\n\n[... קוצר לסיכום ...]"
      : currentPrompt;

  const prompt = `אתה עוזר לשפר פרומפט לנציג AI בוואטסאפ בעברית.

סוג האימון: ${modeLabel}
שם הנציג: ${session.agentName}

הפרומפט הנוכחי:
---
${trimmedPrompt}
---

תמליל האימון (המאמן משחק לקוח):
---
${transcript || "(אין שיחה — רק הערות)"}
---

הערות המאמן במהלך האימון:
---
${feedbackLines || "(אין הערות)"}
---

על בסיס השיחה וההערות, עדכן את הפרומפט כך שהנציג יתנהג טוב יותר.
שמור על מבנה דומה לפרומפט המקורי. אל תמחק מידע חשוב מבסיס הידע.
הוסף או שנה רק מה שנדרש לפי ההערות.

החזר JSON במבנה:
{
  "summaryHebrew": "סיכום קצר בעברית",
  "feedbackPoints": ["נקודה 1"],
  "changeHighlights": ["שינוי 1"],
  "revisedSystemPrompt": "הפרומפט המלא המעודכן בעברית"
}`;

  let parsed;
  try {
    parsed = await callModelJson(prompt, 16384);
  } catch (firstErr) {
    console.warn("⚠️ סיכום אימון — ניסיון שני:", firstErr.message);
    const fallbackPrompt = `שפר פרומפט נציג AI בעברית לפי ההערות.

הערות:
${feedbackLines}

תמליל:
${transcript}

פרומפט נוכחי (התחלה):
${trimmedPrompt.slice(0, 6000)}

החזר JSON עם summaryHebrew, feedbackPoints, changeHighlights, revisedSystemPrompt (פרומפט מלא מעודכן).`;
    parsed = await callModelJson(fallbackPrompt, 16384);
  }

  let revised = String(parsed.revisedSystemPrompt || "").trim();
  if (!revised) {
    const additions = [
      ...(Array.isArray(parsed.changeHighlights) ? parsed.changeHighlights : []),
      ...(Array.isArray(parsed.feedbackPoints) ? parsed.feedbackPoints : []),
    ]
      .filter(Boolean)
      .map(String);
    if (additions.length) {
      revised =
        currentPrompt +
        "\n\n**עדכונים מאימון:**\n" +
        additions.map((a) => `- ${a}`).join("\n");
    }
  }
  if (!revised) throw new Error("המודל לא החזיר פרומפט מעודכן");

  session.summary = {
    summaryHebrew: String(parsed.summaryHebrew || "").trim(),
    feedbackPoints: Array.isArray(parsed.feedbackPoints)
      ? parsed.feedbackPoints.map(String)
      : [],
    changeHighlights: Array.isArray(parsed.changeHighlights)
      ? parsed.changeHighlights.map(String)
      : [],
    revisedSystemPrompt: revised,
    basedOnPrompt: currentPrompt,
  };

  return {
    mode: session.mode,
    summary: session.summary,
    messages: session.messages,
    feedback: session.feedback,
  };
}

async function applyTrainingSummary(sessionId, revisedPrompt) {
  const session = getSession(sessionId);
  if (!session) throw new Error("סשן אימון לא נמצא או שפג תוקפו");

  const prompt = String(revisedPrompt || "").trim();
  if (!prompt) throw new Error("חסר פרומפט לעדכון");

  const patch =
    session.mode === "inbound"
      ? { inbound: { systemPromptOverride: prompt } }
      : { outbound: { systemPromptOverride: prompt } };

  const config = await setAiAgentConfig(patch);
  sessions.delete(sessionId);

  const inboundPreview = await previewInboundPrompt();
  const outboundPreview = await previewOutboundPrompt();

  return {
    config,
    previews: { inbound: inboundPreview, outbound: outboundPreview },
    appliedMode: session.mode,
  };
}

function discardTrainingSession(sessionId) {
  sessions.delete(sessionId);
}

module.exports = {
  startTrainingSession,
  trainingChat,
  addTrainingFeedback,
  summarizeTrainingSession,
  applyTrainingSummary,
  discardTrainingSession,
  getSession,
};
