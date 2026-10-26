/**
 * End-to-end check of Sign in with Google against a local stand-in for Google
 * (token + userinfo addresses). Nothing leaves this machine and no Google Cloud
 * project, account or key is needed:
 *
 *   node scripts/test-google-flow.js
 *
 * Starts the real server twice as child processes (one with Google set up, one
 * without) on a throwaway SQLite file, so data.sqlite is untouched, and plays
 * the part of the browser by hand (cookies and all).
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const G_PORT = 4400, ON_PORT = 4401, OFF_PORT = 4402;
const SECRET = "test-client-secret-5678";
const dbFile = path.join(os.tmpdir(), `journey-google-test-${process.pid}.sqlite`);

/* ---- a fake Google ---- */
const seen = [];
const PROFILES = {
  goodcode: { sub: "100", name: "Test Traveller", email: "G.Traveller@Example.test", email_verified: true },
  unverified: { sub: "101", name: "Not Verified", email: "unverified@example.test", email_verified: false },
  noemail: { sub: "102", name: "No Email" },
};
const google = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    const url = new URL(req.url, `http://localhost:${G_PORT}`);
    seen.push({ method: req.method, path: url.pathname, form: Object.fromEntries(new URLSearchParams(body)), auth: req.headers.authorization || "", type: req.headers["content-type"] || "" });
    res.setHeader("Content-Type", "application/json");
    if (url.pathname === "/token" && req.method === "POST") {
      const f = Object.fromEntries(new URLSearchParams(body));
      if (PROFILES[f.code] && f.client_secret === SECRET && f.grant_type === "authorization_code") return res.end(JSON.stringify({ access_token: `tok-${f.code}`, token_type: "Bearer", id_token: "ignored" }));
      res.statusCode = 400; return res.end(JSON.stringify({ error: "invalid_grant" }));
    }
    if (url.pathname === "/userinfo") {
      const code = String(req.headers.authorization || "").replace("Bearer tok-", "");
      if (PROFILES[code]) return res.end(JSON.stringify(PROFILES[code]));
      res.statusCode = 401; return res.end("{}");
    }
    res.statusCode = 404; res.end("{}");
  });
});

function startServer(port, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    env: { ...process.env, PORT: String(port), SQLITE_PATH: dbFile, JWT_SECRET: "test-secret", NODE_ENV: "development", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => process.stderr.write(String(d)));
  });
}

const get = (base, p, headers = {}) => fetch(base + p, { redirect: "manual", headers });
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("g_oauth=")) || "";
const linkFrom = (html) => { const m = html.match(/href="(journeyapp:\/\/auth\?[^"]+)"/); return m ? new URL(m[1].replace(/&amp;/g, "&")) : null; };
const codeFrom = (html) => linkFrom(html)?.searchParams.get("code") ?? null;
const errorFrom = (html) => linkFrom(html)?.searchParams.get("error") ?? null;
const providerFrom = (html) => linkFrom(html)?.searchParams.get("provider") ?? null;

(async () => {
  let pass = 0; const ok = (name) => { pass++; console.log("PASS", name); };
  await new Promise((r) => google.listen(G_PORT, r));
  const ON = `http://localhost:${ON_PORT}`, OFF = `http://localhost:${OFF_PORT}`;
  const on = await startServer(ON_PORT, { GOOGLE_WEB_CLIENT_ID: "CLIENT123.apps.test", GOOGLE_WEB_CLIENT_SECRET: SECRET, PUBLIC_BASE_URL: ON, GOOGLE_AUTH_URL: `http://localhost:${G_PORT}/auth`, GOOGLE_TOKEN_URL: `http://localhost:${G_PORT}/token`, GOOGLE_USERINFO_URL: `http://localhost:${G_PORT}/userinfo` });
  const off = await startServer(OFF_PORT, { GOOGLE_WEB_CLIENT_ID: "", GOOGLE_WEB_CLIENT_SECRET: "" });
  try {
    /* not configured */
    assert.deepEqual(await (await get(OFF, "/auth/google/status")).json(), { configured: false }); ok("without keys: status says configured:false");
    const offStart = await get(OFF, "/auth/google/start"); const offHtml = await offStart.text();
    assert.equal(offStart.status, 200); assert.equal(errorFrom(offHtml), "not_configured"); assert.equal(providerFrom(offHtml), "google"); assert.match(offHtml, /isn(&#39;|.)t available yet/); ok("without keys: /start shows a plain 'not available yet' page (and says it is Google), no redirect");
    const half = await startServer(4403, { GOOGLE_WEB_CLIENT_ID: "only-an-id", GOOGLE_WEB_CLIENT_SECRET: "" });
    try { assert.deepEqual(await (await get("http://localhost:4403", "/auth/google/status")).json(), { configured: false }); ok("an id without a secret still counts as not set up"); } finally { half.kill(); }

    /* configured: start */
    assert.deepEqual(await (await get(ON, "/auth/google/status")).json(), { configured: true }); ok("with keys: status says configured:true");
    const start = await get(ON, "/auth/google/start");
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, `http://localhost:${G_PORT}/auth`);
    assert.equal(loc.searchParams.get("client_id"), "CLIENT123.apps.test");
    assert.equal(loc.searchParams.get("redirect_uri"), `${ON}/auth/google/callback`);
    assert.equal(loc.searchParams.get("response_type"), "code");
    assert.equal(loc.searchParams.get("scope"), "openid email profile");
    assert.equal(loc.searchParams.get("prompt"), "select_account");
    assert.ok(loc.searchParams.get("state").length > 20);
    assert.ok(!start.headers.get("location").includes(SECRET)); ok("/start redirects to Google with the client id, callback, scopes, account chooser and a signed state, and never the secret");
    const cookie = cookieOf(start);
    const setCookie = start.headers.getSetCookie().join(";");
    assert.ok(cookie.length > 12); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.match(setCookie, /Path=\/auth\/google/); ok("/start sets an HttpOnly, SameSite cookie, limited to /auth/google, tying the sign-in to this browser");
    const state = loc.searchParams.get("state");

    /* callback: happy path */
    const cb = await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(state)}`, { Cookie: cookie });
    const cbHtml = await cb.text(); const code = codeFrom(cbHtml);
    assert.equal(cb.status, 200); assert.ok(code && code.length > 20); assert.ok(!/eyJ/.test(cbHtml)); assert.equal(providerFrom(cbHtml), "google"); ok("callback: opens the app with a one-time code and provider=google, and no login token anywhere in the link");
    const tokenCall = seen.find((s) => s.path === "/token");
    assert.equal(tokenCall.form.client_secret, SECRET); assert.equal(tokenCall.form.redirect_uri, `${ON}/auth/google/callback`); assert.equal(tokenCall.form.client_id, "CLIENT123.apps.test"); assert.match(tokenCall.type, /x-www-form-urlencoded/);
    const infoCall = seen.find((s) => s.path === "/userinfo"); assert.equal(infoCall.auth, "Bearer tok-goodcode"); ok("the secret goes to Google's token address only, as a form post, and the profile is read with the access token");

    /* exchange */
    const ex = await post(ON, "/auth/google/exchange", { code }); const exBody = await ex.json();
    assert.equal(ex.status, 200); assert.ok(exBody.token); assert.equal(exBody.user.email, "g.traveller@example.test"); assert.equal(exBody.user.name, "Test Traveller"); ok("exchange: returns a login token and the user (email lower-cased)");
    const me = await fetch(`${ON}/auth/me`, { headers: { Authorization: `Bearer ${exBody.token}` } }); assert.equal(me.status, 200); assert.equal((await me.json()).user.email, "g.traveller@example.test"); ok("the token works on /auth/me, like an email sign-in");
    assert.equal((await post(ON, "/auth/google/exchange", { code })).status, 400); ok("a one-time code works once only");
    assert.equal((await post(ON, "/auth/google/exchange", { code: "nonsense" })).status, 400); assert.equal((await post(ON, "/auth/google/exchange", {})).status, 400); ok("junk or missing codes are refused");
    const startX = await get(ON, "/auth/google/start"); const stateX = new URL(startX.headers.get("location")).searchParams.get("state");
    const cbX = await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(stateX)}`, { Cookie: cookieOf(startX) });
    assert.equal((await post(ON, "/auth/facebook/exchange", { code: codeFrom(await cbX.text()) })).status, 400); ok("a Google code cannot be redeemed through the Facebook exchange");

    /* same person again: same account */
    const start2 = await get(ON, "/auth/google/start"); const state2 = new URL(start2.headers.get("location")).searchParams.get("state");
    const cb2 = await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(state2)}`, { Cookie: cookieOf(start2) });
    const ex2 = await (await post(ON, "/auth/google/exchange", { code: codeFrom(await cb2.text()) })).json(); assert.equal(ex2.user.id, exBody.user.id); ok("signing in again finds the same account (no duplicate)");

    /* attacks and failures */
    const noCookie = await (await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(state2)}`)).text(); assert.equal(errorFrom(noCookie), "state"); assert.equal(codeFrom(noCookie), null); ok("a callback from a different browser (no cookie) is refused");
    const wrongCookie = await (await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(state2)}`, { Cookie: "g_oauth=somebody-elses" })).text(); assert.equal(errorFrom(wrongCookie), "state"); ok("a callback with someone else's cookie is refused");
    const tampered = await (await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(state2.slice(0, -3) + "abc")}`, { Cookie: cookieOf(start2) })).text(); assert.equal(errorFrom(tampered), "state"); ok("a tampered state is refused");
    const fbState = require("jsonwebtoken").sign({ n: "abc", k: "fb" }, "test-secret", { expiresIn: "10m" });
    const wrongKind = await (await get(ON, `/auth/google/callback?code=goodcode&state=${encodeURIComponent(fbState)}`, { Cookie: "g_oauth=abc" })).text(); assert.equal(errorFrom(wrongKind), "state"); ok("a state signed for Facebook is not accepted by Google");
    const start3 = await get(ON, "/auth/google/start"); const st3 = new URL(start3.headers.get("location")).searchParams.get("state");
    const noEmail = await (await get(ON, `/auth/google/callback?code=noemail&state=${encodeURIComponent(st3)}`, { Cookie: cookieOf(start3) })).text(); assert.equal(errorFrom(noEmail), "no_email"); assert.equal(codeFrom(noEmail), null); ok("a Google account with no email is told to use email sign-in; nothing is created");
    const start3b = await get(ON, "/auth/google/start"); const st3b = new URL(start3b.headers.get("location")).searchParams.get("state");
    const unverified = await (await get(ON, `/auth/google/callback?code=unverified&state=${encodeURIComponent(st3b)}`, { Cookie: cookieOf(start3b) })).text(); assert.equal(errorFrom(unverified), "no_email"); assert.equal(codeFrom(unverified), null); assert.match(unverified, /verified/); ok("an email Google has NOT verified is refused, so nobody can claim someone else's address");
    const start4 = await get(ON, "/auth/google/start"); const st4 = new URL(start4.headers.get("location")).searchParams.get("state");
    const badCode = await (await get(ON, `/auth/google/callback?code=bad&state=${encodeURIComponent(st4)}`, { Cookie: cookieOf(start4) })).text(); assert.equal(errorFrom(badCode), "exchange"); ok("a code Google rejects gives a friendly retry page");
    const denied = await (await get(ON, "/auth/google/callback?error=access_denied")).text(); assert.equal(errorFrom(denied), "cancelled"); assert.equal(providerFrom(denied), "google"); ok("tapping Cancel on Google gives a 'cancelled' page");
    const other = await (await get(ON, "/auth/google/callback?error=server_error")).text(); assert.equal(errorFrom(other), "google_error"); ok("any other error from Google gives a plain 'didn't work' page");
    const users = require("better-sqlite3")(dbFile).prepare("SELECT COUNT(*) AS n FROM users").get().n; assert.equal(users, 1); ok("only one account was created in all of this (the person with a verified email)");

    /* the older route and Facebook are untouched */
    const legacy = await post(ON, "/auth/google", {}); const legacyBody = await legacy.json();
    assert.equal(legacy.status, 400); assert.match(legacyBody.error, /Missing idToken/); ok("the older POST /auth/google route still answers (the new routes did not swallow it)");
    assert.deepEqual(await (await get(ON, "/auth/facebook/status")).json(), { configured: false }); ok("Facebook's routes are unaffected");
    console.log(`\nAll ${pass} checks passed.`);
  } catch (err) {
    console.error("\nFAILED:", err.message); process.exitCode = 1;
  } finally {
    on.kill(); off.kill(); google.close();
    for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
  }
})();
