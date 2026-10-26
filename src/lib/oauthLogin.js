/**
 * The parts "Sign in with Facebook" and "Sign in with Google" have in common.
 * Both are done on this server (see routes/facebookAuth.js for the full story of
 * the steps) so the phone app needs no new native code and the provider's secret
 * never leaves here. What they share lives here so a fix to one is a fix to both:
 *
 *  - a short-lived cookie tied to a signed `state`, so only the browser that
 *    started a sign-in can finish it (stops "login CSRF"),
 *  - one-time codes (60 seconds, single use) that carry the person back to the
 *    app instead of the login token itself,
 *  - the little "Open Jourrrney" page the browser ends on,
 *  - finding or creating the account by email, and rate limits.
 */
const crypto = require("node:crypto");

const CODE_TTL_MS = 60 * 1000;
const HTTP_TIMEOUT_MS = 8000;

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** `cookie` is { name, path }; `base` is this server's public address (decides the Secure flag). */
function setStateCookie(res, base, cookie, nonce, maxAgeSeconds) {
  const secure = base.startsWith("https://") ? "; Secure" : "";
  res.append("Set-Cookie", `${cookie.name}=${encodeURIComponent(nonce)}; HttpOnly; SameSite=Lax; Path=${cookie.path}; Max-Age=${maxAgeSeconds}${secure}`);
}

/** True when the nonce inside the signed state is the same one in this browser's cookie. */
function sameBrowser(stateNonce, cookieNonce) {
  return !!(stateNonce && cookieNonce && stateNonce.length === cookieNonce.length && crypto.timingSafeEqual(Buffer.from(stateNonce), Buffer.from(cookieNonce)));
}

/** In-memory limits, fine for one server instance (as in routes/auth.js). */
const hits = new Map();
function tooMany(key, max, windowMs) {
  const now = Date.now();
  const list = (hits.get(key) || []).filter((t) => now - t < windowMs);
  list.push(now);
  hits.set(key, list);
  return list.length > max;
}

/** One-time codes: code -> { userId, expires }. Used once, then gone. Each provider keeps its own store. */
function createCodeStore() {
  const codes = new Map();
  return {
    issue(userId) {
      const now = Date.now();
      for (const [k, v] of codes) if (v.expires < now) codes.delete(k);
      const code = crypto.randomBytes(24).toString("base64url");
      codes.set(code, { userId, expires: now + CODE_TTL_MS });
      return code;
    },
    redeem(code) {
      const entry = codes.get(code);
      codes.delete(code);
      return entry && entry.expires >= Date.now() ? entry.userId : null;
    },
  };
}

async function request(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, body };
  } finally {
    clearTimeout(timer);
  }
}
const getJson = (url, headers) => request(url, headers ? { headers } : undefined);
const postForm = (url, fields) =>
  request(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });

/**
 * Builds the page the browser ends on, with a big button that opens the app.
 * `messages` maps a reason to [title, text]; `provider`, when set, is added to the
 * link (…&provider=google) so the app knows which exchange to call. Facebook leaves
 * it out, so its links stay exactly as phones that already have them expect.
 */
function createAppPage({ messages, provider }) {
  return function appPage(res, c, kind, query) {
    const [title, text] = messages[kind] || messages.exchange;
    const deepLink = `${c.scheme}://auth?${query || `error=${encodeURIComponent(kind)}`}${provider ? `&provider=${provider}` : ""}`;
    res.status(200).set({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#0E1424;color:#F4EEE2;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}main{max-width:420px;text-align:center}h1{font-size:24px;line-height:1.3;margin:0 0 10px}p{font-size:17px;line-height:1.5;margin:0 0 24px;color:#D9D3C5}a{display:block;background:#D8B878;color:#0E1424;font-weight:700;font-size:18px;text-decoration:none;border-radius:14px;padding:16px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="${esc(deepLink)}">Open Jourrrney</a></main>
<script>setTimeout(function(){window.location.href=${JSON.stringify(deepLink)}},150)</script></body></html>`);
  };
}

/** Finds the account for this email, or creates it. Accounts are keyed by email, whichever way the person signs in. */
function findOrCreateUserByEmail(db, email, name) {
  let user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, email, name);
    user = db.prepare("SELECT * FROM users WHERE id = ?").get(id);
  }
  return user;
}

module.exports = { esc, readCookie, setStateCookie, sameBrowser, tooMany, createCodeStore, getJson, postForm, createAppPage, findOrCreateUserByEmail };
