/**
 * Real email + one-time-code authentication — matches the app's existing
 * "enter email → enter 6-digit code" UI exactly: the code is generated,
 * hashed, stored and verified here, and it is emailed to the address the user
 * typed (see lib/mailer.js — RESEND_API_KEY or BREVO_API_KEY plus EMAIL_FROM).
 *
 * With an email provider configured the code is ONLY delivered by email: it
 * is never logged and never echoed back in the response, because returning a
 * login code to the device that asked for it would defeat the point of a
 * second factor.
 *
 * With NO provider configured (local development) the old behaviour remains:
 * the code is logged to this server's console and, outside NODE_ENV=production,
 * echoed back as `devCode` so the flow is testable without an inbox. In
 * production with no provider, /request-code fails with 503 rather than
 * pretending to send something.
 */
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");
const requireAuth = require("../middleware/requireAuth");
const { configuredProvider, sendLoginCode } = require("../lib/mailer");

const router = express.Router();

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// Because /request-code now sends real email, it must not be usable to spam
// someone's inbox or burn the provider's daily quota. In-memory limits —
// fine for one server instance (Render free tier is exactly that); swap for a
// shared store if this ever runs on several.
const MIN_SECONDS_BETWEEN_CODES = 25; // the app's resend countdown is 30s
const MAX_CODES_PER_EMAIL_PER_HOUR = 6;
const MAX_CODES_PER_IP_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const emailRequests = new Map(); // email -> number[] (request timestamps)
const ipRequests = new Map(); // ip -> number[]

function recent(map, key, windowMs, now) {
  const kept = (map.get(key) || []).filter((t) => now - t < windowMs);
  map.set(key, kept);
  return kept;
}

/** Returns an error message if this request is over a limit, else records it and returns null. */
function throttle(email, ip) {
  const now = Date.now();
  const byEmail = recent(emailRequests, email, HOUR_MS, now);
  const byIp = recent(ipRequests, ip, HOUR_MS, now);

  const last = byEmail[byEmail.length - 1];
  if (last && now - last < MIN_SECONDS_BETWEEN_CODES * 1000) {
    const wait = Math.ceil((MIN_SECONDS_BETWEEN_CODES * 1000 - (now - last)) / 1000);
    return `Please wait ${wait}s before asking for another code.`;
  }
  if (byEmail.length >= MAX_CODES_PER_EMAIL_PER_HOUR) {
    return "Too many codes requested for this email — try again in an hour.";
  }
  if (byIp.length >= MAX_CODES_PER_IP_PER_HOUR) {
    return "Too many requests from this device — try again in an hour.";
  }
  byEmail.push(now);
  byIp.push(now);
  return null;
}

// One client ID per platform Google issues a distinct audience for
// (expo-auth-session's iOS/Android/Web flows each get their own). Any of
// these that isn't configured is simply not accepted as a valid audience.
const GOOGLE_CLIENT_IDS = [
  process.env.GOOGLE_IOS_CLIENT_ID,
  process.env.GOOGLE_ANDROID_CLIENT_ID,
  process.env.GOOGLE_WEB_CLIENT_ID,
].filter(Boolean);

const googleClient = new OAuth2Client();

function hashCode(code) {
  return crypto.createHash("sha256").update(code).digest("hex");
}

function isValidEmail(email) {
  return typeof email === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// POST /auth/request-code { email }
router.post("/request-code", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const provider = configuredProvider();
  const isProduction = process.env.NODE_ENV === "production";
  if (!provider && isProduction) {
    console.error("[auth] /request-code called but no email provider is configured (set RESEND_API_KEY or BREVO_API_KEY + EMAIL_FROM)");
    return res.status(503).json({ error: "Email sign-in isn't available right now. Please try again later." });
  }

  const limited = throttle(email, req.ip || "unknown");
  if (limited) return res.status(429).json({ error: limited });

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

  db.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts)
     VALUES (@email, @codeHash, @expiresAt, 0)
     ON CONFLICT(email) DO UPDATE SET code_hash = @codeHash, expires_at = @expiresAt, attempts = 0`,
  ).run({ email, codeHash: hashCode(code), expiresAt });

  if (provider) {
    try {
      await sendLoginCode(email, code, CODE_TTL_MINUTES);
    } catch (err) {
      // A code nobody received shouldn't stay valid.
      db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
      console.error(`[auth] sending login code failed via ${provider}: ${err.message}${err.detail ? ` — ${err.detail}` : ""}`);
      return res.status(502).json({ error: "We couldn't send the code just now. Please try again in a moment." });
    }
    // Delivered by email only: no devCode, and the code is not logged.
    return res.json({ ok: true });
  }

  // Development fallback — no provider configured, not production.
  console.log(`[auth] DEV login code for ${email}: ${code} (expires in ${CODE_TTL_MINUTES}m) — no email provider configured, nothing was sent`);
  res.json({ ok: true, devCode: code });
});

// POST /auth/verify-code { email, code, name? }
router.post("/verify-code", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const code = String(req.body?.code || "").trim();
  const name = req.body?.name ? String(req.body.name).trim().slice(0, 80) : null;

  const row = db.prepare("SELECT * FROM login_codes WHERE email = ?").get(email);
  if (!row) return res.status(400).json({ error: "Request a new code first." });

  if (new Date(row.expires_at).getTime() < Date.now()) {
    db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
    return res.status(400).json({ error: "That code expired — request a new one." });
  }

  if (row.attempts >= MAX_ATTEMPTS) {
    db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);
    return res.status(429).json({ error: "Too many attempts — request a new code." });
  }

  if (hashCode(code) !== row.code_hash) {
    db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE email = ?").run(email);
    return res.status(400).json({ error: "Incorrect code." });
  }

  db.prepare("DELETE FROM login_codes WHERE email = ?").run(email);

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, email, name);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// POST /auth/google { idToken } — sign in/up with a Google-issued ID token
// (the client gets this from expo-auth-session, never a raw access token).
router.post("/google", async (req, res) => {
  const idToken = String(req.body?.idToken || "").trim();
  if (!idToken) return res.status(400).json({ error: "Missing idToken." });
  if (GOOGLE_CLIENT_IDS.length === 0) {
    return res.status(500).json({ error: "Google sign-in isn't configured on this server." });
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_IDS });
    payload = ticket.getPayload();
  } catch {
    return res.status(401).json({ error: "Invalid Google sign-in." });
  }

  if (!payload?.email || payload.email_verified !== true) {
    return res.status(401).json({ error: "Google account has no verified email." });
  }
  const email = payload.email.trim().toLowerCase();
  const name = payload.name ? String(payload.name).trim().slice(0, 80) : null;

  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, email, name);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }

  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// GET /auth/me — requires Authorization: Bearer <token>
router.get("/me", requireAuth, (req, res) => {
  const user = db.prepare("SELECT id, email, name, created_at FROM users WHERE id = ?").get(req.userId);
  if (!user) return res.status(401).json({ error: "Account not found." });
  res.json({ user });
});

module.exports = router;
