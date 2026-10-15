/**
 * Sends the sign-in code to the address the user typed — over an HTTPS email
 * API, not SMTP: Render's free web services block outbound SMTP ports
 * (25 / 465 / 587), so anything SMTP-based would just time out there.
 *
 * Two providers are supported, picked by whichever key is set (Resend wins if
 * both are). Set exactly one of:
 *
 *   RESEND_API_KEY   https://resend.com   — needs a verified sending domain to
 *                    reach anyone other than your own account address.
 *   BREVO_API_KEY    https://brevo.com    — free tier 300/day; the sender must
 *                    be verified (a domain you own gives the best inbox rate).
 *
 * plus EMAIL_FROM, e.g.  Jourrrney <login@yourdomain.com>
 *
 * With neither key set, configuredProvider() returns null and the auth route
 * falls back to its dev behaviour (see routes/auth.js).
 */

const RESEND_URL = process.env.RESEND_API_URL || "https://api.resend.com/emails";
const BREVO_URL = process.env.BREVO_API_URL || "https://api.brevo.com/v3/smtp/email";
const SEND_TIMEOUT_MS = 12_000;

function configuredProvider() {
  if (process.env.RESEND_API_KEY) return "resend";
  if (process.env.BREVO_API_KEY) return "brevo";
  return null;
}

/** "Jourrrney <login@example.com>" or "login@example.com" -> { name, email } */
function parseFrom(raw) {
  const value = String(raw || "").trim();
  const m = value.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || "Jourrrney", email: m[2].trim() };
  return { name: "Jourrrney", email: value };
}

function buildMessage(code, ttlMinutes) {
  const subject = `${code} is your Jourrrney sign-in code`;
  const text =
    `Your Jourrrney sign-in code is ${code}\n\n` +
    `It expires in ${ttlMinutes} minutes. Enter it in the app to finish signing in.\n\n` +
    `If you didn't ask for this code, you can ignore this email — nobody can sign in without it.`;
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#1C1917">` +
    `<p style="margin:0 0 4px;font-size:13px;letter-spacing:2px;color:#333C81;font-weight:700">JOURRRNEY</p>` +
    `<h1 style="margin:0 0 12px;font-size:20px">Your sign-in code</h1>` +
    `<p style="margin:0 0 16px;font-size:14px;line-height:20px">Enter this code in the app to finish signing in:</p>` +
    `<p style="margin:0 0 16px;font-size:32px;letter-spacing:8px;font-weight:700;background:#F3F1EE;border-radius:12px;padding:16px;text-align:center">${code}</p>` +
    `<p style="margin:0 0 8px;font-size:13px;line-height:19px;color:#57534E">It expires in ${ttlMinutes} minutes.</p>` +
    `<p style="margin:0;font-size:13px;line-height:19px;color:#57534E">If you didn't ask for this code, you can ignore this email — nobody can sign in without it.</p>` +
    `</div>`;
  return { subject, text, html };
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!res.ok) {
    // Provider error bodies describe the problem (unverified sender, bad
    // key, ...) and contain no secrets — safe to log, never sent to the app.
    const detail = (await res.text().catch(() => "")).slice(0, 400);
    const err = new Error(`email provider responded ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
}

/** Sends the code. Resolves on success, throws on any failure. */
async function sendLoginCode(to, code, ttlMinutes) {
  const provider = configuredProvider();
  if (!provider) throw new Error("no email provider configured");

  const from = process.env.EMAIL_FROM;
  if (!from) throw new Error("EMAIL_FROM is not set");
  const { subject, text, html } = buildMessage(code, ttlMinutes);

  if (provider === "resend") {
    await postJson(RESEND_URL, { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, { from, to: [to], subject, text, html });
    return;
  }

  const sender = parseFrom(from);
  await postJson(
    BREVO_URL,
    { "api-key": process.env.BREVO_API_KEY },
    { sender: { name: sender.name, email: sender.email }, to: [{ email: to }], subject, textContent: text, htmlContent: html },
  );
}

module.exports = { configuredProvider, sendLoginCode, parseFrom };
