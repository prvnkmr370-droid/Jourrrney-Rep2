/**
 * End-to-end check of Sign in with Facebook against a local stand-in for
 * Facebook (login dialog + Graph API). Nothing leaves this machine and no
 * Facebook app, account or key is needed:
 *
 *   node scripts/test-facebook-flow.js
 *
 * Starts the real server twice as child processes (one with Facebook set up,
 * one without) on a throwaway SQLite file, so data.sqlite is untouched, and
 * plays the part of the browser by hand (cookies and all).
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const FB_PORT = 4390, ON_PORT = 4391, OFF_PORT = 4392;
const SECRET = "test-app-secret-1234";
const dbFile = path.join(os.tmpdir(), `journey-fb-test-${process.pid}.sqlite`);

/* ---- a fake Facebook ---- */
const seen = [];
const PROFILES = { goodcode: { id: "100", name: "Test Traveller", email: "Fb.Traveller@Example.test" }, noemail: { id: "101", name: "Phone Only" } };
const fb = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${FB_PORT}`);
  seen.push({ path: url.pathname, q: Object.fromEntries(url.searchParams) });
  res.setHeader("Content-Type", "application/json");
  if (url.pathname === "/oauth/access_token") {
    const code = url.searchParams.get("code");
    if (PROFILES[code] && url.searchParams.get("client_secret") === SECRET) return res.end(JSON.stringify({ access_token: `tok-${code}`, token_type: "bearer" }));
    res.statusCode = 400; return res.end(JSON.stringify({ error: { message: "bad code" } }));
  }
  if (url.pathname === "/me") {
    const code = String(url.searchParams.get("access_token") || "").replace("tok-", "");
    if (PROFILES[code]) return res.end(JSON.stringify(PROFILES[code]));
    res.statusCode = 401; return res.end("{}");
  }
  res.statusCode = 404; res.end("{}");
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
const cookieOf = (res) => (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).find((c) => c.startsWith("fb_oauth=")) || "";
const codeFrom = (html) => { const m = html.match(/journeyapp:\/\/auth\?code=([^"&<]+)/); return m ? decodeURIComponent(m[1]) : null; };
const errorFrom = (html) => { const m = html.match(/journeyapp:\/\/auth\?error=([a-z_]+)/); return m ? m[1] : null; };

(async () => {
  let pass = 0; const ok = (name) => { pass++; console.log("PASS", name); };
  await new Promise((r) => fb.listen(FB_PORT, r));
  const ON = `http://localhost:${ON_PORT}`, OFF = `http://localhost:${OFF_PORT}`;
  const on = await startServer(ON_PORT, { FACEBOOK_APP_ID: "APP123", FACEBOOK_APP_SECRET: SECRET, PUBLIC_BASE_URL: ON, FACEBOOK_GRAPH_URL: `http://localhost:${FB_PORT}`, FACEBOOK_DIALOG_URL: `http://localhost:${FB_PORT}/dialog/oauth`, SUPPORT_EMAIL: "help@example.test" });
  const off = await startServer(OFF_PORT, { FACEBOOK_APP_ID: "", FACEBOOK_APP_SECRET: "" });
  try {
    /* not configured */
    assert.deepEqual(await (await get(OFF, "/auth/facebook/status")).json(), { configured: false }); ok("without keys: status says configured:false");
    const offStart = await get(OFF, "/auth/facebook/start"); const offHtml = await offStart.text();
    assert.equal(offStart.status, 200); assert.equal(errorFrom(offHtml), "not_configured"); assert.match(offHtml, /isn(&#39;|.)t available yet/); ok("without keys: /start shows a plain 'not available yet' page, no redirect to Facebook");

    /* configured: start */
    assert.deepEqual(await (await get(ON, "/auth/facebook/status")).json(), { configured: true }); ok("with keys: status says configured:true");
    const start = await get(ON, "/auth/facebook/start");
    assert.equal(start.status, 302);
    const loc = new URL(start.headers.get("location"));
    assert.equal(loc.origin + loc.pathname, `http://localhost:${FB_PORT}/dialog/oauth`);
    assert.equal(loc.searchParams.get("client_id"), "APP123");
    assert.equal(loc.searchParams.get("redirect_uri"), `${ON}/auth/facebook/callback`);
    assert.equal(loc.searchParams.get("scope"), "public_profile,email");
    assert.equal(loc.searchParams.get("response_type"), "code");
    assert.ok(loc.searchParams.get("state").length > 20);
    assert.ok(!start.headers.get("location").includes(SECRET)); ok("/start redirects to Facebook with the app id, callback, scope and a signed state, and never the secret");
    const cookie = cookieOf(start);
    assert.ok(cookie.length > 12); const setCookie = start.headers.getSetCookie().join(";"); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); ok("/start sets an HttpOnly, SameSite cookie tying the sign-in to this browser");
    const state = loc.searchParams.get("state");

    /* callback: happy path */
    const cb = await get(ON, `/auth/facebook/callback?code=goodcode&state=${encodeURIComponent(state)}`, { Cookie: cookie });
    const cbHtml = await cb.text(); const code = codeFrom(cbHtml);
    assert.equal(cb.status, 200); assert.ok(code && code.length > 20); assert.ok(!/eyJ/.test(cbHtml)); ok("callback: opens the app with a one-time code, and no login token anywhere in the link");
    const tokenCall = seen.find((s) => s.path === "/oauth/access_token");
    assert.equal(tokenCall.q.client_secret, SECRET); assert.equal(tokenCall.q.redirect_uri, `${ON}/auth/facebook/callback`);
    const meCall = seen.find((s) => s.path === "/me"); assert.match(meCall.q.appsecret_proof, /^[0-9a-f]{64}$/); assert.equal(meCall.q.fields, "id,name,email"); ok("the secret is used only server to server, and the Graph call carries an appsecret_proof");

    /* exchange */
    const ex = await post(ON, "/auth/facebook/exchange", { code }); const exBody = await ex.json();
    assert.equal(ex.status, 200); assert.ok(exBody.token); assert.equal(exBody.user.email, "fb.traveller@example.test"); assert.equal(exBody.user.name, "Test Traveller"); ok("exchange: returns a login token and the user (email lower-cased)");
    const me = await fetch(`${ON}/auth/me`, { headers: { Authorization: `Bearer ${exBody.token}` } }); assert.equal(me.status, 200); assert.equal((await me.json()).user.email, "fb.traveller@example.test"); ok("the token works on /auth/me, like an email sign-in");
    assert.equal((await post(ON, "/auth/facebook/exchange", { code })).status, 400); ok("a one-time code works once only");
    assert.equal((await post(ON, "/auth/facebook/exchange", { code: "nonsense" })).status, 400); assert.equal((await post(ON, "/auth/facebook/exchange", {})).status, 400); ok("junk or missing codes are refused");

    /* same person again: same account */
    const start2 = await get(ON, "/auth/facebook/start"); const state2 = new URL(start2.headers.get("location")).searchParams.get("state");
    const cb2 = await get(ON, `/auth/facebook/callback?code=goodcode&state=${encodeURIComponent(state2)}`, { Cookie: cookieOf(start2) });
    const ex2 = await (await post(ON, "/auth/facebook/exchange", { code: codeFrom(await cb2.text()) })).json(); assert.equal(ex2.user.id, exBody.user.id); ok("signing in again finds the same account (no duplicate)");

    /* attacks and failures */
    const noCookie = await (await get(ON, `/auth/facebook/callback?code=goodcode&state=${encodeURIComponent(state2)}`)).text(); assert.equal(errorFrom(noCookie), "state"); assert.equal(codeFrom(noCookie), null); ok("a callback from a different browser (no cookie) is refused");
    const wrongCookie = await (await get(ON, `/auth/facebook/callback?code=goodcode&state=${encodeURIComponent(state2)}`, { Cookie: "fb_oauth=somebody-elses" })).text(); assert.equal(errorFrom(wrongCookie), "state"); ok("a callback with someone else's cookie is refused");
    const tampered = await (await get(ON, `/auth/facebook/callback?code=goodcode&state=${encodeURIComponent(state2.slice(0, -3) + "abc")}`, { Cookie: cookieOf(start2) })).text(); assert.equal(errorFrom(tampered), "state"); ok("a tampered state is refused");
    const start3 = await get(ON, "/auth/facebook/start"); const st3 = new URL(start3.headers.get("location")).searchParams.get("state");
    const noEmail = await (await get(ON, `/auth/facebook/callback?code=noemail&state=${encodeURIComponent(st3)}`, { Cookie: cookieOf(start3) })).text(); assert.equal(errorFrom(noEmail), "no_email"); assert.match(noEmail, /email/); ok("a Facebook account with no email is told to use email sign-in; nothing is created");
    const start4 = await get(ON, "/auth/facebook/start"); const st4 = new URL(start4.headers.get("location")).searchParams.get("state");
    const badCode = await (await get(ON, `/auth/facebook/callback?code=bad&state=${encodeURIComponent(st4)}`, { Cookie: cookieOf(start4) })).text(); assert.equal(errorFrom(badCode), "exchange"); ok("a code Facebook rejects gives a friendly retry page");
    const denied = await (await get(ON, "/auth/facebook/callback?error=access_denied&error_reason=user_denied")).text(); assert.equal(errorFrom(denied), "cancelled"); ok("tapping Cancel on Facebook gives a 'cancelled' page");
    const users = require("better-sqlite3")(dbFile).prepare("SELECT COUNT(*) AS n FROM users").get().n; assert.equal(users, 1); ok("only one account was created in all of this (the person with an email)");

    /* data deletion page */
    const del = await (await get(ON, "/auth/facebook/data-deletion")).text(); assert.match(del, /help@example\.test/); assert.match(del, /Delete your Jourrrney data/); ok("the data-deletion page for Meta exists and shows the support address");
    console.log(`\nAll ${pass} checks passed.`);
  } catch (err) {
    console.error("\nFAILED:", err.message); process.exitCode = 1;
  } finally {
    on.kill(); off.kill(); fb.close();
    for (const f of [dbFile, dbFile + "-wal", dbFile + "-shm"]) fs.rmSync(f, { force: true });
  }
})();
