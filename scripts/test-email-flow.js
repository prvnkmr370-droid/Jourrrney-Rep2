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
  let n = 0;
  const step = (name) => console.log(`ok ${++n} - ${name}`);

  // 1. Resend: code is emailed to the typed address, not echoed back.
  process.env.NODE_ENV = "development";
  process.env.RESEND_API_KEY = "re_test_key";
  delete process.env.BREVO_API_KEY;
  let r = await post("/request-code", { email: "Traveller@Example.test" });
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
  step("emailed code verifies and returns a session token (wrong code rejected)");

  // 3. Asking again straight away is throttled.
  r = await post("/request-code", { email: "traveller@example.test" });
  assert.equal(r.status, 429);
  assert.equal(received.length, 1, "no second email while throttled");
  step("second request within 25s is throttled and sends nothing");

  // 4. Provider rejects: 502, nothing left valid.
  providerStatus = 403;
  r = await post("/request-code", { email: "fail@example.test" });
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
  r = await post("/request-code", { email: "brevo@example.test" });
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
  r = await post("/request-code", { email: "dev@example.test" });
  assert.equal(r.status, 200);
  assert.match(r.json.devCode, /^\d{6}$/);
  step("no provider, development: devCode echoed as before");
  process.env.NODE_ENV = "production";
  r = await post("/request-code", { email: "prod@example.test" });
  assert.equal(r.status, 503);
  assert.equal(r.json.devCode, undefined);
  step("no provider, production: 503 instead of pretending to send");

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
