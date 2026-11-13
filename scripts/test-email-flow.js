/**
 * End-to-end check of the email sign-in code flow against a local stand-in
 * for the email provider's HTTPS API — nothing leaves this machine and no
 * real account or key is needed:
 *
 *   node scripts/test-email-flow.js
 *
 * Uses a throwaway SQLite file, so data.sqlite is untouched.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

process.env.SQLITE_PATH = path.join(os.tmpdir(), `journey-email-test-${process.pid}.sqlite`);
process.env.JWT_SECRET = "test-secret";
process.env.EMAIL_FROM = "Jourrrney <login@example.test>";

const received = [];
let providerStatus = 200;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push({ url: req.url, headers: req.headers, body: JSON.parse(body || "{}") });
    res.writeHead(providerStatus, { "Content-Type": "application/json" });
    res.end(providerStatus === 200 ? '{"id":"test"}' : '{"message":"rejected by test provider"}');
  });
});

async function main() {
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${provider.address().port}`;
  process.env.RESEND_API_URL = `${base}/resend/emails`;
  process.env.BREVO_API_URL = `${base}/brevo/smtp/email`;

  const express = require("express");
  const authRoutes = require("../src/routes/auth");
  const app = express();
  app.use(express.json());
  app.use("/auth", authRoutes);
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const api = `http://127.0.0.1:${server.address().port}/auth`;
  const post = async (p, body) => {
    const r = await fetch(api + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() };
  };
  const codeFrom = (msg) => msg.body.subject.match(/^(\d{6}) /)[1];
  const db = require("../src/db"); // the same throwaway file the routes use
  /** The body of a "create an account" request: names, and the 18+ tick. */
  const signup = (email, extra = {}) => ({ email, mode: "signup", firstName: "Tara", lastName: "Traveller", ageConfirmed: true, ...extra });
  const getMe = async (token) => {
    const r = await fetch(api + "/me", { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, json: await r.json() };
  };
  let n = 0;
  const step = (name) => console.log(`ok ${++n} - ${name}`);

  // 1. Resend: code is emailed to the typed address, not echoed back.
  process.env.NODE_ENV = "development";
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.BREVO_API_KEY;
  let r = await post("/request-code", signup("Traveller@Example.test"));
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.devCode, undefined, "devCode must not be returned when an email provider is configured");
  assert.equal(received.length, 1);
  const m1 = received[0];
  assert.equal(m1.url, "/resend/emails");
  assert.equal(m1.headers.authorization, "Bearer re_test_key");
  assert.deepEqual(m1.body.to, ["traveller@example.test"]);
  assert.equal(m1.body.from, "Jourrrney <login@example.test>");
  const code = codeFrom(m1);
  assert.ok(m1.body.text.includes(code) && m1.body.html.includes(code));
  step("Resend: code emailed to the typed address, no devCode in the response");

  // 2. The emailed code signs the user in.
  const wrong = await post("/verify-code", { email: "traveller@example.test", code: code === "000000" ? "111111" : "000000" });
  assert.equal(wrong.status, 400);
  const ok = await post("/verify-code", { email: "traveller@example.test", code });
  assert.equal(ok.status, 200);
  assert.ok(ok.json.token && ok.json.user.email === "traveller@example.test");
  assert.equal(ok.json.user.name, "Tara Traveller");
  assert.equal(ok.json.user.firstName, "Tara");
  assert.equal(ok.json.user.lastName, "Traveller");
  step("emailed code verifies, creates the account with the typed name, and returns a session token (wrong code rejected)");

  // 3. Asking again straight away is throttled.
  r = await post("/request-code", { email: "traveller@example.test" });
  assert.equal(r.status, 429);
  assert.equal(received.length, 1, "no second email while throttled");
  step("second request within 25s is throttled and sends nothing");

  // 4. Provider rejects: 502, nothing left valid.
  providerStatus = 403;
  r = await post("/request-code", signup("fail@example.test"));
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes("rejected by test provider"), "provider detail must not reach the app");
  providerStatus = 200;
  const stale = await post("/verify-code", { email: "fail@example.test", code: "123456" });
  assert.equal(stale.status, 400);
  assert.match(stale.json.error, /Request a new code/);
  step("provider failure -> 502 for the app, stored code removed, provider detail not leaked");

  // 5. Brevo request shape.
  delete process.env.RESEND_API_KEY;
  process.env.BREVO_API_KEY = "xkeysib-test";
  const before = received.length;
  r = await post("/request-code", signup("brevo@example.test"));
  assert.equal(r.status, 200);
  assert.equal(r.json.devCode, undefined);
  const m2 = received[before];
  assert.equal(m2.url, "/brevo/smtp/email");
  assert.equal(m2.headers["api-key"], "xkeysib-test");
  assert.deepEqual(m2.body.sender, { name: "Jourrrney", email: "login@example.test" });
  assert.deepEqual(m2.body.to, [{ email: "brevo@example.test" }]);
  assert.ok(m2.body.htmlContent.includes(codeFrom(m2)) && m2.body.textContent.includes(codeFrom(m2)));
  step("Brevo: sender / to / content shape and api-key header");

  // 6. No provider: dev echo outside production, 503 in production.
  delete process.env.BREVO_API_KEY;
  r = await post("/request-code", signup("dev@example.test"));
  assert.equal(r.status, 200);
  assert.match(r.json.devCode, /^\d{6}$/);
  step("no provider, development: devCode echoed as before");
  process.env.NODE_ENV = "production";
  r = await post("/request-code", { email: "prod@example.test" });
  assert.equal(r.status, 503);
  assert.equal(r.json.devCode, undefined);
  step("no provider, production: 503 instead of pretending to send");

  // 6b. On Render the code must never be shown, even if NODE_ENV was left on "development"
  // (that was the live server's setting, and it showed every sign-in code to whoever asked).
  process.env.NODE_ENV = "development";
  process.env.RENDER = "true";
  const logged = [];
  const realLog = console.log;
  console.log = (...args) => logged.push(args.join(" "));
  try {
    r = await post("/request-code", { email: "hosted@example.test" });
  } finally {
    console.log = realLog;
  }
  assert.equal(r.status, 503);
  assert.equal(r.json.devCode, undefined);
  assert.ok(!JSON.stringify(r.json).match(/\d{6}/), "no code anywhere in the response");
  assert.ok(!logged.some((line) => /login code|\d{6}/i.test(line)), "the code must not be written to the server log either");
  const row = require("better-sqlite3")(process.env.SQLITE_PATH, { readonly: true }).prepare("SELECT 1 FROM login_codes WHERE email = ?").get("hosted@example.test");
  assert.equal(row, undefined, "no sign-in code is stored when nothing can be sent");
  delete process.env.RENDER;
  step("on Render with no provider, even with NODE_ENV=development: 503, no code returned, none logged, none stored");

  // 6c. The sign-up rules: no account without a name and the 18+ tick, and a sign-in never makes one.
  process.env.NODE_ENV = "development";
  const countRows = (table, email) => db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE email = ?`).get(email).n;
  const mailsBefore = received.length;

  r = await post("/request-code", { email: "newcomer@example.test" });
  assert.equal(r.status, 404);
  assert.equal(r.json.code, "no_account");
  assert.match(r.json.error, /no Jourrrney account/i);
  assert.equal(countRows("login_codes", "newcomer@example.test"), 0, "no code is stored");
  assert.equal(received.length, mailsBefore, "nothing is emailed");
  step("signing in with an address that has no account: 404 no_account, nothing stored, nothing sent");

  r = await post("/request-code", signup("newcomer@example.test", { firstName: "Nia", lastName: "Newcomer" }));
  assert.equal(r.status, 200, "the person can go straight on to create the account (the 404 did not use up the wait)");
  const newcomerCode = r.json.devCode;
  assert.match(newcomerCode, /^\d{6}$/);
  const created = await post("/verify-code", { email: "newcomer@example.test", code: newcomerCode });
  assert.equal(created.status, 200);
  assert.equal(created.json.user.name, "Nia Newcomer");
  step("creating the account straight after that works, and the account is made only when the code is confirmed");

  const bad = [
    [{ firstName: "" }, "invalid_signup", "firstName"],
    [{ firstName: "   " }, "invalid_signup", "firstName"],
    [{ firstName: "R2D2" }, "invalid_signup", "firstName"],
    [{ firstName: "A".repeat(41) }, "invalid_signup", "firstName"],
    [{ lastName: "" }, "invalid_signup", "lastName"],
    [{ lastName: "Smith <script>" }, "invalid_signup", "lastName"],
    [{ ageConfirmed: false }, "age_required", "ageConfirmed"],
    [{ ageConfirmed: "true" }, "age_required", "ageConfirmed"],
    [{ ageConfirmed: undefined }, "age_required", "ageConfirmed"],
  ];
  for (const [extra, code, field] of bad) {
    const email = `bad-${Math.random().toString(36).slice(2, 8)}@example.test`;
    r = await post("/request-code", signup(email, extra));
    assert.equal(r.status, 400, JSON.stringify(extra));
    assert.equal(r.json.code, code, JSON.stringify(extra));
    assert.equal(r.json.field, field, JSON.stringify(extra));
    assert.ok(r.json.error && !/undefined|\[object/.test(r.json.error), "a plain-words message");
    assert.equal(countRows("login_codes", email), 0, "nothing stored");
  }
  assert.equal(received.length, mailsBefore, "no email for a refused sign-up");
  step("an account request without a first name, a last name or the 18+ tick is refused with a plain message and stores nothing");

  r = await post("/request-code", signup("tidy@example.test", { firstName: "  Asha   Maria ", lastName: "  O'Neil-Müller " }));
  assert.equal(r.status, 200);
  const tidy = await post("/verify-code", { email: "tidy@example.test", code: r.json.devCode });
  assert.equal(tidy.json.user.firstName, "Asha Maria");
  assert.equal(tidy.json.user.lastName, "O'Neil-Müller");
  assert.equal(tidy.json.user.name, "Asha Maria O'Neil-Müller");
  const tidyRow = db.prepare("SELECT first_name, last_name, age_confirmed_at FROM users WHERE email = ?").get("tidy@example.test");
  assert.equal(tidyRow.first_name, "Asha Maria");
  assert.ok(Math.abs(Date.now() - new Date(tidyRow.age_confirmed_at).getTime()) < 60_000, "the 18+ confirmation is stored with the time it was given");
  const me = await getMe(tidy.json.token);
  assert.equal(me.status, 200);
  assert.equal(me.json.user.firstName, "Asha Maria");
  assert.equal(me.json.user.lastName, "O'Neil-Müller");
  step("names are tidied (extra spaces, accents and apostrophes kept), the 18+ confirmation time is stored, and /me returns the names");

  const replay = await post("/verify-code", { email: "tidy@example.test", code: r.json.devCode });
  assert.equal(replay.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get("tidy@example.test").n, 1);
  step("the same code cannot be used twice, and makes only one account");

  const oldId = "11111111-1111-4111-8111-111111111111";
  db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(oldId, "veteran@example.test", "Vera Veteran");
  r = await post("/request-code", signup("veteran@example.test", { firstName: "Someone", lastName: "Else" }));
  assert.equal(r.status, 200, "an address that already has an account just signs in");
  assert.equal(db.prepare("SELECT signup_json FROM login_codes WHERE email = ?").get("veteran@example.test").signup_json, null, "the typed details are not kept");
  const back = await post("/verify-code", { email: "veteran@example.test", code: r.json.devCode });
  assert.equal(back.json.user.id, oldId);
  assert.equal(back.json.user.name, "Vera Veteran", "the existing name is not overwritten");
  assert.equal(back.json.user.firstName, null);
  step("'creating' an account for an address that already has one signs that account in and overwrites nothing");

  r = await post("/request-code", { email: "ghost@example.test", mode: "delete" });
  assert.equal(r.status, 200, "the delete-account page can still ask for a code");
  const ghost = await post("/verify-code", { email: "ghost@example.test", code: r.json.devCode });
  assert.equal(ghost.status, 400);
  assert.equal(ghost.json.code, "no_account");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").get("ghost@example.test").n, 0);
  step("a code asked for any way other than creating an account can never create one");

  // 7. Bad address.
  r = await post("/request-code", { email: "not-an-email" });
  assert.equal(r.status, 400);
  step("invalid address rejected");

  server.close();
  provider.close();
  console.log(`\nall ${n} checks passed`);
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
