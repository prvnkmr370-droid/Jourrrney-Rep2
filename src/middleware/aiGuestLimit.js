/**
 * Free AI prompts for people who are not signed in.
 *
 * Signing in is never required to use the app, but the AI is what an account unlocks: a guest gets a few free
 * AI prompts (AI_GUEST_PROMPT_LIMIT, 5 unless set) and then needs to sign in to keep using AI. Everything that
 * is not AI is untouched, and a signed-in person is not limited here.
 *
 * What counts as one prompt: the app sends the same X-AI-Prompt-Id on every AI call that belongs to one thing the
 * person did (a trip with three stops makes three calls, still one prompt). A call with no id counts as its own
 * prompt. Only a call that gets an answer is counted, so an AI outage never uses up someone's free prompts.
 *
 * Whose count: the phone's random id (X-Device-Id, made by the app and kept on the phone). A call without one is
 * counted against its network address instead, so an older app or a script cannot dodge the limit by leaving it
 * out. A second, looser safety net caps how many guest AI calls one network address can make a day, so changing
 * the device id on every call does not get around it either (AI_GUEST_IP_DAILY_CAP, in memory).
 *
 * The count lives in the database (ai_guest_prompts). On a host whose database is wiped on restart (Render's free
 * plan today) the counts start again after a restart: that costs a few free prompts, nothing more.
 */
const crypto = require("node:crypto");
const db = require("../db");

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_ID = /^[A-Za-z0-9-]{8,64}$/;

const hasPrompt = db.prepare("SELECT 1 FROM ai_guest_prompts WHERE device_key = ? AND prompt_id = ?");
const countPrompts = db.prepare("SELECT COUNT(*) AS n FROM ai_guest_prompts WHERE device_key = ?");
const addPrompt = db.prepare("INSERT OR IGNORE INTO ai_guest_prompts (device_key, prompt_id) VALUES (?, ?)");

const callsByIp = new Map(); // ip -> timestamps of guest AI calls in the last day

function number(name, fallback) {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
const guestLimit = () => number("AI_GUEST_PROMPT_LIMIT", 5);
const ipDailyCap = () => number("AI_GUEST_IP_DAILY_CAP", 60);

function guestKey(req) {
  const id = String(req.headers["x-device-id"] || "");
  return UUID.test(id) ? `device:${id.toLowerCase()}` : `ip:${req.ip || "unknown"}`;
}

function promptIdOf(req) {
  const id = String(req.headers["x-ai-prompt-id"] || "");
  return PROMPT_ID.test(id) ? id : crypto.randomUUID();
}

/** Records this call for the network-address safety net; true when the address is over its daily cap. */
function overIpCap(ip) {
  const now = Date.now();
  const recent = (callsByIp.get(ip) || []).filter((t) => now - t < DAY_MS);
  if (recent.length >= ipDailyCap()) { callsByIp.set(ip, recent); return true; }
  recent.push(now);
  callsByIp.set(ip, recent);
  return false;
}

const summary = (key, limit) => {
  const used = countPrompts.get(key).n;
  return { used, limit, remaining: Math.max(0, limit - used) };
};

/** Use after optionalAuth on every route that calls an AI provider. */
function aiGuestGate(req, res, next) {
  if (req.userId) return next(); // signed in: not limited here

  const limit = guestLimit();
  const key = guestKey(req);
  const promptId = promptIdOf(req);
  const already = !!hasPrompt.get(key, promptId);
  const { used } = summary(key, limit);

  if (!already && used >= limit) {
    return res.status(403).json({
      code: "guest_limit",
      error: `You've used your ${limit} free AI prompts. Sign in to keep using AI. It's free.`,
      limit,
      used,
    });
  }
  if (overIpCap(req.ip || "unknown")) {
    return res.status(429).json({ code: "guest_ip_limit", error: "There have been a lot of AI prompts from this network today. Sign in to keep using AI.", limit });
  }

  // Count the prompt only when the call is answered, and tell the app how many are left.
  const send = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode < 400 && body && typeof body === "object" && !Array.isArray(body)) {
      addPrompt.run(key, promptId);
      body = { ...body, guest: summary(key, limit) };
    }
    return send(body);
  };
  next();
}

/** GET /plan-trip/ai-access: how many free AI prompts this phone has left (a signed-in person has no limit). Calls no AI. */
function aiAccessStatus(req, res) {
  if (req.userId) return res.json({ signedIn: true });
  return res.json({ signedIn: false, ...summary(guestKey(req), guestLimit()) });
}

module.exports = { aiGuestGate, aiAccessStatus };
