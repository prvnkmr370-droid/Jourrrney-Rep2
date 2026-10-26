/**
 * Sign in with Google, done on this server in exactly the same way as Sign in
 * with Facebook (see routes/facebookAuth.js for the story of each step), so the
 * phone app needs no new native code and Google's client secret never leaves here.
 *
 *   1. The app checks GET /auth/google/status, then opens GET /auth/google/start
 *      in the phone's browser.
 *   2. /start sends the browser to Google's account chooser, with a signed `state`
 *      and a matching cookie so only this browser can finish the sign-in.
 *   3. Google sends the browser back to GET /auth/google/callback with a `code`.
 *      This server swaps it for an access token with the client secret, asks Google
 *      "who is this?" (name, email, and whether Google has verified the email),
 *      finds or creates the account by email, and issues a ONE-TIME code (60 s).
 *   4. The page opens the app with  <scheme>://auth?code=<one-time code>&provider=google.
 *   5. The app calls POST /auth/google/exchange { code } and gets the normal
 *      { token, user } an email sign-in returns.
 *
 * Needs GOOGLE_WEB_CLIENT_ID and GOOGLE_WEB_CLIENT_SECRET (Google Cloud console,
 * OAuth client of type "Web application"), with <PUBLIC_BASE_URL>/auth/google/callback
 * listed under "Authorised redirect URIs". With either unset, /status says
 * configured:false and the app shows a plain "not available yet" message.
 *
 * Accounts here are keyed by email, so an email Google has NOT verified is refused:
 * trusting it would let someone claim another person's account by typing their
 * address into a Google account they control.
 *
 * The older POST /auth/google { idToken } route in routes/auth.js is separate and
 * unchanged; this router only answers /status, /start, /callback and /exchange.
 */
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const express = require("express");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");
const { readCookie, setStateCookie, sameBrowser, tooMany, createCodeStore, getJson, postForm, createAppPage, findOrCreateUserByEmail } = require("../lib/oauthLogin");

const router = express.Router();

const COOKIE = { name: "g_oauth", path: "/auth/google" };
const STATE_TTL = "10m";
const codes = createCodeStore();

/** Read on every request, so tests (and a Render env change) take effect without code changes. */
function config() {
  return {
    clientId: (process.env.GOOGLE_WEB_CLIENT_ID || "").trim(),
    clientSecret: (process.env.GOOGLE_WEB_CLIENT_SECRET || "").trim(),
    base: (process.env.PUBLIC_BASE_URL || "https://jourrrney-backend.onrender.com").replace(/\/+$/, ""),
    scheme: (process.env.APP_SCHEME || "journeyapp").trim(),
    // The three Google addresses are overridable only so tests can stand in for Google.
    authUrl: process.env.GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token",
    userInfoUrl: process.env.GOOGLE_USERINFO_URL || "https://openidconnect.googleapis.com/v1/userinfo",
  };
}
const isConfigured = (c) => c.clientId !== "" && c.clientSecret !== "";
const callbackUrl = (c) => `${c.base}/auth/google/callback`;

const MESSAGES = {
  ok: ["You're signed in", "Opening the Jourrrney app…"],
  cancelled: ["Sign-in cancelled", "You chose not to continue with Google. You can try again, or sign in with your email."],
  no_email: ["We need a verified email", "Google didn't share a verified email address with us, so we can't create your account. Please sign in with your email in the app instead."],
  state: ["That sign-in link has expired", "Please go back to the app and tap “Sign in with Google” again."],
  exchange: ["Google sign-in didn't work", "Something went wrong talking to Google. Please try again in a moment."],
  google_error: ["Google sign-in didn't work", "Google sent back an error. Please try again in a moment."],
  not_configured: ["Google sign-in isn't available yet", "Please sign in with your email in the app for now."],
};
const appPage = createAppPage({ messages: MESSAGES, provider: "google" });

// GET /auth/google/status — lets the app decide before it opens the browser.
router.get("/status", (_req, res) => {
  res.json({ configured: isConfigured(config()) });
});

// GET /auth/google/start — sends the browser to Google.
router.get("/start", (req, res) => {
  const c = config();
  if (!isConfigured(c)) return appPage(res, c, "not_configured");
  if (tooMany(`google:start:${req.ip}`, 40, 60 * 60 * 1000)) return res.status(429).send("Too many attempts. Please try again later.");

  const nonce = crypto.randomBytes(18).toString("base64url");
  const state = jwt.sign({ n: nonce, k: "google" }, JWT_SECRET, { expiresIn: STATE_TTL });
  setStateCookie(res, c.base, COOKIE, nonce, 600);
  const url = new URL(c.authUrl);
  url.searchParams.set("client_id", c.clientId);
  url.searchParams.set("redirect_uri", callbackUrl(c));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  // Always show the account chooser: many phones are signed in to several Google accounts.
  url.searchParams.set("prompt", "select_account");
  res.set("Cache-Control", "no-store").redirect(302, url.toString());
});

// GET /auth/google/callback — Google sends the browser back here.
router.get("/callback", async (req, res) => {
  const c = config();
  if (!isConfigured(c)) return appPage(res, c, "not_configured");
  // The cookie has done its job either way.
  setStateCookie(res, c.base, COOKIE, "", 0);

  if (req.query.error) return appPage(res, c, req.query.error === "access_denied" ? "cancelled" : "google_error");

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const cookieNonce = readCookie(req, COOKIE.name);
  let stateNonce = null;
  try {
    const payload = jwt.verify(state, JWT_SECRET);
    if (payload && payload.k === "google" && typeof payload.n === "string") stateNonce = payload.n;
  } catch {
    // expired or tampered
  }
  if (!code || !sameBrowser(stateNonce, cookieNonce)) return appPage(res, c, "state");

  try {
    // 1. code -> access token (server to server, with the client secret)
    const tokenRes = await postForm(c.tokenUrl, {
      code,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: callbackUrl(c),
      grant_type: "authorization_code",
    });
    const accessToken = tokenRes.ok && typeof tokenRes.body.access_token === "string" ? tokenRes.body.access_token : null;
    if (!accessToken) return appPage(res, c, "exchange");

    // 2. who is this?
    const me = await getJson(c.userInfoUrl, { Authorization: `Bearer ${accessToken}` });
    if (!me.ok || !me.body || !me.body.sub) return appPage(res, c, "exchange");

    const email = typeof me.body.email === "string" ? me.body.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@") || me.body.email_verified !== true) return appPage(res, c, "no_email");
    const name = me.body.name ? String(me.body.name).trim().slice(0, 80) : null;

    // 3. find or create the account
    const user = findOrCreateUserByEmail(db, email, name);
    return appPage(res, c, "ok", `code=${encodeURIComponent(codes.issue(user.id))}`);
  } catch (err) {
    console.error("Google sign-in failed:", err && err.name === "AbortError" ? "Google did not answer in time" : "unexpected error");
    return appPage(res, c, "exchange");
  }
});

// POST /auth/google/exchange { code } — the app swaps the one-time code for the normal login.
router.post("/exchange", (req, res) => {
  if (tooMany(`google:exchange:${req.ip}`, 30, 10 * 60 * 1000)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
  const code = String(req.body?.code || "").trim();
  const userId = code ? codes.redeem(code) : null;
  const user = userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) : null;
  if (!user) return res.status(400).json({ error: "That sign-in has expired. Please try again." });
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

module.exports = router;
