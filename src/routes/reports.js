/**
 * Reporting an AI reply or an AI-written plan: the app's "Report" button. Google Play requires apps that
 * generate content with AI to let people flag offensive or harmful output without leaving the app.
 *
 * POST /reports  { kind, reason, comment?, content, context? }      (signed in: AI is for signed-in people)
 *   kind     "chat_reply" (one of Tia's replies) or "trip_plan" (an AI-written day-by-day plan)
 *   reason   "wrong" | "unsafe" | "offensive" | "other"
 *   comment  the person's own note, up to 500 characters (optional)
 *   content  the text being reported, up to 4000 characters
 *   context  what the person had asked just before, up to 500 characters (optional)
 *
 * A report is stored in `ai_reports` (and removed with the account) and, when SUPPORT_EMAIL is set and an
 * email service is connected, a copy is emailed there. The email is what actually reaches the owner: on a host
 * whose database is wiped on restart (Render's free plan) the stored copy does not last. The log line holds the
 * report number, kind and reason only, never the text. At most 20 reports a person a day.
 */
const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");
const { configuredProvider, sendNotice } = require("../lib/mailer");

const router = express.Router();

const KINDS = ["chat_reply", "trip_plan"];
const REASONS = {
  wrong: "Wrong or misleading",
  unsafe: "Unsafe or could cause harm",
  offensive: "Offensive or inappropriate",
  other: "Something else",
};
const KIND_LABEL = { chat_reply: "a reply from Tia", trip_plan: "an AI-written trip plan" };
const MAX_CONTENT = 4000;
const MAX_CONTEXT = 500;
const MAX_COMMENT = 500;
const MAX_PER_DAY = 20;

const clean = (value, max) => String(value ?? "").replace(/\r/g, "").trim().slice(0, max);

function supportEmail() {
  const v = (process.env.SUPPORT_EMAIL || "").trim();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/.test(v) ? v : "";
}

const countToday = db.prepare("SELECT COUNT(*) AS n FROM ai_reports WHERE user_id = ? AND created_at > datetime('now', '-1 day')");
const insert = db.prepare("INSERT INTO ai_reports (user_id, kind, reason, comment, content, context) VALUES (?, ?, ?, ?, ?, ?)");
const emailOf = db.prepare("SELECT email FROM users WHERE id = ?");

router.post("/", requireAuth, async (req, res) => {
  const kind = req.body?.kind;
  const reason = req.body?.reason;
  if (!KINDS.includes(kind)) return res.status(400).json({ error: "We couldn't tell what is being reported." });
  if (!Object.prototype.hasOwnProperty.call(REASONS, reason)) return res.status(400).json({ error: "Please choose a reason." });
  const content = clean(req.body?.content, MAX_CONTENT);
  if (!content) return res.status(400).json({ error: "There is nothing to report." });
  const comment = clean(req.body?.comment, MAX_COMMENT) || null;
  const context = clean(req.body?.context, MAX_CONTEXT) || null;

  if (countToday.get(req.userId).n >= MAX_PER_DAY) {
    return res.status(429).json({ error: "You have sent a lot of reports today. Thank you. Please try again tomorrow." });
  }

  const id = Number(insert.run(req.userId, kind, reason, comment, content, context).lastInsertRowid);
  console.log(`[report] #${id} ${kind} ${reason}`);

  // Tell the owner. Failing to send the email never fails the report: it is already stored.
  const to = supportEmail();
  if (to && configuredProvider()) {
    const reporter = emailOf.get(req.userId)?.email || "unknown";
    const text =
      `Someone reported ${KIND_LABEL[kind]} in Jourrrney.\n\n` +
      `Report: #${id}\nReason: ${REASONS[reason]}\nReporter: ${reporter}\n` +
      `${comment ? `Their note: ${comment}\n` : ""}${context ? `What they had asked: ${context}\n` : ""}` +
      `\n--- The reported text ---\n${content}\n`;
    try {
      await sendNotice(to, `AI report #${id}: ${REASONS[reason]}`, text);
    } catch (err) {
      console.error(`[report] #${id} could not be emailed: ${err.message}`);
    }
  }

  res.status(201).json({ ok: true });
});

module.exports = router;
