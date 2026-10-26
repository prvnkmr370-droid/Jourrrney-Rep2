/**
 * Sign in with Facebook, done on this server so the phone app needs no new
 * native code and Facebook's App Secret never leaves here.
 *
 *   1. The app checks GET /auth/facebook/status, then opens
 *      GET /auth/facebook/start in the phone's browser.
 *   2. /start sends the browser to Facebook's login dialog. It sets a short-lived
 *      cookie and puts the matching value inside a signed `state`, so only the
 *      browser that started the sign-in can finish it (a link someone else
 *      started is refused: that is the "login CSRF" attack).
 *   3. Facebook sends the browser back to GET /auth/facebook/callback with a
 *      `code`. This server swaps the code for an access token using the App
 *      Secret, reads the person's id, name and email from the Graph API, finds
 *      or creates the account by email (the same way /auth/google does), and
 *      issues a ONE-TIME code, valid for 60 seconds.
 *   4. The callback page opens the app with  <scheme>://auth?code=<one-time code>.
 *      The login token itself is never put in that link, because another app on
 *      the phone could register the same link scheme and read it.
 *   5. The app calls POST /auth/facebook/exchange { code } and receives the same
 *      { token, user } the email sign-in returns.
 *
 * Needs FACEBOOK_APP_ID and FACEBOOK_APP_SECRET (Meta for Developers, app type
 * "Consumer", product "Facebook Login"), and the redirect address
 * <PUBLIC_BASE_URL>/auth/facebook/callback added to "Valid OAuth Redirect URIs".
 * With either one unset, /status says configured:false and the app shows a
 * plain "not available yet" message instead of opening the browser.
 *
 * A Facebook account can have no email (phone-only accounts, or the person
 * declines it). Accounts here are keyed by email, so those people are asked to
 * use email sign-in instead; nothing is created for them.
 *
 * The pieces shared with Google sign-in (cookie, one-time codes, the result
 * page) live in lib/oauthLogin.js.
 */
const crypto = require("node:crypto");
const jwt = require("jsonwebtoken");
const express = require("express");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");
const { esc, readCookie, setStateCookie, sameBrowser, tooMany, createCodeStore, getJson, createAppPage, findOrCreateUserByEmail } = require("../lib/oauthLogin");

const router = express.Router();

const COOKIE = { name: "fb_oauth", path: "/auth/facebook" };
const STATE_TTL = "10m";
const codes = createCodeStore();

/** Read on every request, so tests (and a Render env change) take effect without code changes. */
function config() {
  return {
    appId: (process.env.FACEBOOK_APP_ID || "").trim(),
    appSecret: (process.env.FACEBOOK_APP_SECRET || "").trim(),
    base: (process.env.PUBLIC_BASE_URL || "https://jourrrney-backend.onrender.com").replace(/\/+$/, ""),
    scheme: (process.env.APP_SCHEME || "journeyapp").trim(),
    // Unversioned on purpose: Facebook then uses the app's own default version, so a retired
    // numbered version can't break sign-in. Overridable for tests.
    graph: (process.env.FACEBOOK_GRAPH_URL || "https://graph.facebook.com").replace(/\/+$/, ""),
    dialog: process.env.FACEBOOK_DIALOG_URL || "https://www.facebook.com/dialog/oauth",
    support: (process.env.SUPPORT_EMAIL || "").trim(),
  };
}
const isConfigured = (c) => c.appId !== "" && c.appSecret !== "";
const callbackUrl = (c) => `${c.base}/auth/facebook/callback`;

/** What the person sees in the browser, with a big button that opens the app. */
const MESSAGES = {
  ok: ["You're signed in", "Opening the Jourrrney app…"],
  cancelled: ["Sign-in cancelled", "You chose not to continue with Facebook. You can try again, or sign in with your email."],
  no_email: ["We need your email", "Facebook didn't share an email address with us, so we can't create your account. Please sign in with your email in the app instead."],
  state: ["That sign-in link has expired", "Please go back to the app and tap “Sign in with Facebook” again."],
  exchange: ["Facebook sign-in didn't work", "Something went wrong talking to Facebook. Please try again in a moment."],
  facebook_error: ["Facebook sign-in didn't work", "Facebook sent back an error. Please try again in a moment."],
  not_configured: ["Facebook sign-in isn't available yet", "Please sign in with your email in the app for now."],
};
const appPage = createAppPage({ messages: MESSAGES });

/* ---------- routes ---------- */

// GET /auth/facebook/status — lets the app decide before it opens the browser.
router.get("/status", (_req, res) => {
  res.json({ configured: isConfigured(config()) });
});

// GET /auth/facebook/start — sends the browser to Facebook.
router.get("/start", (req, res) => {
  const c = config();
  if (!isConfigured(c)) return appPage(res, c, "not_configured");
  if (tooMany(`fb:start:${req.ip}`, 40, 60 * 60 * 1000)) return res.status(429).send("Too many attempts. Please try again later.");

  const nonce = crypto.randomBytes(18).toString("base64url");
  const state = jwt.sign({ n: nonce, k: "fb" }, JWT_SECRET, { expiresIn: STATE_TTL });
  setStateCookie(res, c.base, COOKIE, nonce, 600);
  const url = new URL(c.dialog);
  url.searchParams.set("client_id", c.appId);
  url.searchParams.set("redirect_uri", callbackUrl(c));
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "public_profile,email");
  url.searchParams.set("response_type", "code");
  res.set("Cache-Control", "no-store").redirect(302, url.toString());
});

// GET /auth/facebook/callback — Facebook sends the browser back here.
router.get("/callback", async (req, res) => {
  const c = config();
  if (!isConfigured(c)) return appPage(res, c, "not_configured");
  // The cookie has done its job either way.
  setStateCookie(res, c.base, COOKIE, "", 0);

  if (req.query.error) return appPage(res, c, req.query.error === "access_denied" ? "cancelled" : "facebook_error");

  const code = String(req.query.code || "");
  const state = String(req.query.state || "");
  const cookieNonce = readCookie(req, COOKIE.name);
  let stateNonce = null;
  try {
    const payload = jwt.verify(state, JWT_SECRET);
    if (payload && payload.k === "fb" && typeof payload.n === "string") stateNonce = payload.n;
  } catch {
    // expired or tampered
  }
  if (!code || !sameBrowser(stateNonce, cookieNonce)) return appPage(res, c, "state");

  try {
    // 1. code -> access token (server to server, with the App Secret)
    const tokenUrl = new URL(`${c.graph}/oauth/access_token`);
    tokenUrl.searchParams.set("client_id", c.appId);
    tokenUrl.searchParams.set("client_secret", c.appSecret);
    tokenUrl.searchParams.set("redirect_uri", callbackUrl(c));
    tokenUrl.searchParams.set("code", code);
    const tokenRes = await getJson(tokenUrl.toString());
    const accessToken = tokenRes.ok && typeof tokenRes.body.access_token === "string" ? tokenRes.body.access_token : null;
    if (!accessToken) return appPage(res, c, "exchange");

    // 2. who is this? appsecret_proof proves the call comes from this server.
    const meUrl = new URL(`${c.graph}/me`);
    meUrl.searchParams.set("fields", "id,name,email");
    meUrl.searchParams.set("access_token", accessToken);
    meUrl.searchParams.set("appsecret_proof", crypto.createHmac("sha256", c.appSecret).update(accessToken).digest("hex"));
    const me = await getJson(meUrl.toString());
    if (!me.ok || !me.body || !me.body.id) return appPage(res, c, "exchange");

    const email = typeof me.body.email === "string" ? me.body.email.trim().toLowerCase() : "";
    if (!email || !email.includes("@")) return appPage(res, c, "no_email");
    const name = me.body.name ? String(me.body.name).trim().slice(0, 80) : null;

    // 3. find or create the account, exactly as /auth/google does
    const user = findOrCreateUserByEmail(db, email, name);
    return appPage(res, c, "ok", `code=${encodeURIComponent(codes.issue(user.id))}`);
  } catch (err) {
    console.error("Facebook sign-in failed:", err && err.name === "AbortError" ? "Facebook did not answer in time" : "unexpected error");
    return appPage(res, c, "exchange");
  }
});

// POST /auth/facebook/exchange { code } — the app swaps the one-time code for the normal login.
router.post("/exchange", (req, res) => {
  if (tooMany(`fb:exchange:${req.ip}`, 30, 10 * 60 * 1000)) return res.status(429).json({ error: "Too many attempts. Please try again later." });
  const code = String(req.body?.code || "").trim();
  const userId = code ? codes.redeem(code) : null;
  const user = userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) : null;
  if (!user) return res.status(400).json({ error: "That sign-in has expired. Please try again." });
  const token = jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
});

// GET /auth/facebook/data-deletion — the page Meta asks for ("Data Deletion Instructions URL").
router.get("/data-deletion", (_req, res) => {
  const c = config();
  const self = `<a href="${esc(c.base)}/delete-account">${esc(c.base)}/delete-account</a>`;
  const how = c.support
    ? `The quickest way is to delete it yourself at ${self}, or in the app under Profile, Settings, Delete my account. You can also email <a href="mailto:${esc(c.support)}">${esc(c.support)}</a> from the address you signed in with.`
    : `The quickest way is to delete it yourself at ${self}, or in the app under Profile, Settings, Delete my account.`;
  res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Delete your Jourrrney data</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:40px auto;padding:0 20px;line-height:1.6;color:#1b1b1b}h1{font-size:24px}</style></head>
<body><h1>Delete your Jourrrney data</h1><p>If you signed in to Jourrrney with Facebook, we keep your name, your email address, the profile details you added, and a short history of the questions you asked Tia. Places and trips you saved are kept only on your phone.</p><p>${how}</p><p>We never post to your Facebook account and we do not see your Facebook password.</p></body></html>`);
});

module.exports = router;
