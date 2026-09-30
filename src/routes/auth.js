/**
 * Real email + one-time-code authentication — matches the app's existing
 * "enter email → enter 6-digit code" UI exactly, but now backed by a real
 * server: the code is generated and verified here, not just simulated
 * client-side.
 *
 * HONESTY NOTE (read before deploying this anywhere real): there is no
 * email-sending service wired up. The code is logged to this server's
 * console, and — only when NODE_ENV is not "production" — echoed back in
 * the /request-code response as `devCode` so the app is testable end to
 * end without an inbox. Before shipping this for real, plug in an email
 * provider (Resend, SendGrid, Postmark, etc.) in requestCode() below and
 * delete the devCode line — sending a login code back to the same device
 * that requested it defeats the point of a second factor.
 */
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const express = require("express");
const { OAuth2Client } = require("google-auth-library");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

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
router.post("/request-code", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return res.status(400).json({ error: "Enter a valid email address." });
  }

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60_000).toISOString();

  db.prepare(
    `INSERT INTO login_codes (email, code_hash, expires_at, attempts)
     VALUES (@email, @codeHash, @expiresAt, 0)
     ON CONFLICT(email) DO UPDATE SET code_hash = @codeHash, expires_at = @expiresAt, attempts = 0`,
  ).run({ email, codeHash: hashCode(code), expiresAt });

  // Stand-in for real email delivery — see file header.
  console.log(`[auth] login code for ${email}: ${code} (expires in ${CODE_TTL_MINUTES}m)`);

  const body = { ok: true };
  if (process.env.NODE_ENV !== "production") body.devCode = code;
  res.json(body);
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
