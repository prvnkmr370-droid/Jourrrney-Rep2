/**
 * Checks the "Report" button's server side (POST /reports) against a local stand-in for the email service,
 * on a throwaway SQLite file. Nothing leaves this machine:
 *
 *   node scripts/test-reports.js
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

process.env.SQLITE_PATH = path.join(os.tmpdir(), `journey-reports-test-${process.pid}.sqlite`);
process.env.JWT_SECRET = "test-secret";
process.env.EMAIL_FROM = "Jourrrney <login@example.test>";
process.env.NODE_ENV = "development";
process.env.RESEND_API_KEY = "re_test_key";
process.env.SUPPORT_EMAIL = "owner@example.test";

const received = [];
let providerStatus = 200;
const provider = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    received.push(JSON.parse(body || "{}"));
    res.writeHead(providerStatus, { "Content-Type": "application/json" });
    res.end(providerStatus === 200 ? '{"id":"test"}' : '{"message":"rejected by test provider"}');
  });
});

async function main() {
  await new Promise((r) => provider.listen(0, "127.0.0.1", r));
  process.env.RESEND_API_URL = `http://127.0.0.1:${provider.address().port}/emails`;

  const db = require("../src/db");
  const express = require("express");
  const app = express();
  app.use(express.json());
  app.use("/auth", require("../src/routes/auth"));
  app.use("/reports", require("../src/routes/reports"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };

  /** A real sign-up through the real routes; the emailed code is read from the stand-in email service. */
  async function signUp(email) {
    const before = received.length;
    const rc = await call("POST", "/auth/request-code", { email, mode: "signup", firstName: "Rita", lastName: "Reporter", ageConfirmed: true });
    assert.equal(rc.status, 200);
    const code = received[before].subject.match(/^(\d{6}) /)[1];
    const vc = await call("POST", "/auth/verify-code", { email, code });
    assert.equal(vc.status, 200);
    return vc.json;
  }
  const rows = (userId) => db.prepare("SELECT * FROM ai_reports WHERE user_id = ? ORDER BY id").all(userId);
  const noticesToOwner = () => received.filter((m) => (m.to || []).includes("owner@example.test"));

  let n = 0;
  const step = (name) => console.log(`ok ${++n} - ${name}`);
  const good = { kind: "chat_reply", reason: "wrong", content: "Jaipur is famous for its beaches.", context: "somewhere warm in february", comment: "  There are no beaches in Jaipur.  " };

  const rita = await signUp("rita@example.test");
  const sam = await signUp("sam@example.test");

  assert.equal((await call("POST", "/reports", good)).status, 401);
  assert.equal((await call("POST", "/reports", good, "not.a.token")).status, 401);
  step("a report needs a signed-in person");

  for (const [bad, why] of [
    [{ ...good, kind: "something" }, "unknown kind"],
    [{ ...good, kind: undefined }, "no kind"],
    [{ ...good, reason: "rude" }, "unknown reason"],
    [{ ...good, reason: "constructor" }, "a reason that is an object property name"],
    [{ ...good, reason: undefined }, "no reason"],
    [{ ...good, content: "" }, "empty text"],
    [{ ...good, content: "   \n  " }, "blank text"],
    [{ ...good, content: undefined }, "no text"],
  ]) {
    const r = await call("POST", "/reports", bad, rita.token);
    assert.equal(r.status, 400, why);
    assert.ok(r.json.error && !/undefined|\[object/.test(r.json.error), `plain message for ${why}`);
  }
  assert.equal(rows(rita.user.id).length, 0, "nothing was stored for bad requests");
  step("bad requests are refused with a plain message and store nothing");

  const sentBefore = noticesToOwner().length;
  const logged = [];
  const realLog = console.log;
  console.log = (...a) => logged.push(a.join(" "));
  let ok;
  try { ok = await call("POST", "/reports", good, rita.token); } finally { console.log = realLog; }
  assert.equal(ok.status, 201);
  assert.equal(ok.json.ok, true);
  const stored = rows(rita.user.id);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].kind, "chat_reply");
  assert.equal(stored[0].reason, "wrong");
  assert.equal(stored[0].comment, "There are no beaches in Jaipur.", "the note is trimmed");
  assert.equal(stored[0].context, "somewhere warm in february");
  assert.equal(stored[0].content, "Jaipur is famous for its beaches.");
  step("a good report is stored against the signed-in account, with the note trimmed");

  assert.ok(logged.some((l) => /\[report\] #\d+ chat_reply wrong/.test(l)));
  assert.ok(!logged.some((l) => l.includes("beaches")), "the reported text is never written to the log");
  step("the log line holds the report number, kind and reason, never the text");

  const mails = noticesToOwner();
  assert.equal(mails.length, sentBefore + 1);
  const mail = mails[mails.length - 1];
  assert.match(mail.subject, /^AI report #\d+: Wrong or misleading$/);
  assert.ok(mail.text.includes("Jaipur is famous for its beaches."));
  assert.ok(mail.text.includes("rita@example.test"), "the reporter's address is in it, so the owner can follow up");
  assert.ok(mail.text.includes("There are no beaches in Jaipur."));
  assert.ok(mail.text.includes("somewhere warm in february"));
  step("a copy is emailed to SUPPORT_EMAIL with the reason, the reporter, their note and the reported text");

  const long = await call("POST", "/reports", { kind: "trip_plan", reason: "unsafe", content: "x".repeat(6000), comment: "y".repeat(900), context: "z".repeat(900) }, rita.token);
  assert.equal(long.status, 201);
  const lastRow = rows(rita.user.id).pop();
  assert.equal(lastRow.content.length, 4000);
  assert.equal(lastRow.comment.length, 500);
  assert.equal(lastRow.context.length, 500);
  assert.equal(lastRow.kind, "trip_plan");
  step("over-long text is cut to its limit (4000 / 500 / 500), and a plan can be reported too");

  providerStatus = 500;
  const errs = [];
  const realErr = console.error;
  console.error = (...a) => errs.push(a.join(" "));
  let failed;
  try { failed = await call("POST", "/reports", { ...good, reason: "offensive" }, rita.token); } finally { console.error = realErr; providerStatus = 200; }
  assert.equal(failed.status, 201, "the report still succeeds when the email cannot be sent");
  assert.equal(rows(rita.user.id).length, 3);
  assert.ok(errs.some((l) => /could not be emailed/.test(l)));
  assert.ok(!errs.some((l) => l.includes("beaches")), "the text is not in the error log either");
  step("if the email service fails the report is still stored and the person still sees success");

  delete process.env.SUPPORT_EMAIL;
  const quiet = noticesToOwner().length;
  assert.equal((await call("POST", "/reports", { ...good, reason: "other" }, rita.token)).status, 201);
  assert.equal(noticesToOwner().length, quiet, "no email when SUPPORT_EMAIL is not set");
  assert.equal(rows(rita.user.id).length, 4);
  process.env.SUPPORT_EMAIL = "owner@example.test";
  step("with no SUPPORT_EMAIL the report is just stored (no email, no error)");

  assert.equal(rows(sam.user.id).length, 0);
  for (let i = 0; i < 20; i++) assert.equal((await call("POST", "/reports", good, sam.token)).status, 201, `report ${i + 1}`);
  const over = await call("POST", "/reports", good, sam.token);
  assert.equal(over.status, 429);
  assert.match(over.json.error, /tomorrow/);
  assert.equal(rows(sam.user.id).length, 20);
  assert.equal((await call("POST", "/reports", good, rita.token)).status, 201, "another person is not affected");
  step("at most 20 reports a person a day (the 21st gets a friendly 429), and it is per person");

  const del = await call("DELETE", "/auth/account", null, sam.token);
  assert.equal(del.status, 200);
  assert.equal(rows(sam.user.id).length, 0, "Sam's reports went with Sam's account");
  assert.ok(rows(rita.user.id).length >= 5, "Rita's reports are untouched");
  step("deleting an account deletes that person's reports and nobody else's");

  server.close();
  provider.close();
  console.log(`\nall ${n} checks passed`);
  process.exit(0);
}

main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
