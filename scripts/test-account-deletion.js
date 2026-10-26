/**
 * Checks account deletion and the public legal pages against the real server,
 * on a throwaway SQLite file (data.sqlite is untouched), with no email provider
 * (so sign-in codes come back as devCode, as they do in local development):
 *
 *   node scripts/test-account-deletion.js
 *
 * Takes about half a minute: the server allows one sign-in code per email
 * every 25 seconds, so the "sign up again" check waits that out.
 */
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const PORT = 4393, PORT_NO_MAIL = 4394;
const dbFile = path.join(os.tmpdir(), `journey-delete-test-${process.pid}.sqlite`);
process.env.SQLITE_PATH = dbFile;
process.env.JWT_SECRET = "test-secret";
const db = require("../src/db"); // the test reads and writes the same file the server uses
const jwt = require("jsonwebtoken");
const optionalAuth = require("../src/middleware/optionalAuth");

function startServer(port, extraEnv, sqlite) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    env: { ...process.env, PORT: String(port), SQLITE_PATH: sqlite, JWT_SECRET: "test-secret", NODE_ENV: "development", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("server did not start")), 8000);
    child.stdout.on("data", (d) => { if (String(d).includes("listening")) { clearTimeout(t); resolve(child); } });
    child.stderr.on("data", (d) => process.stderr.write(String(d)));
  });
}

let n = 0;
const ok = (label) => console.log(`  ok ${++n}  ${label}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const server = await startServer(PORT, { SUPPORT_EMAIL: "help@example.test" }, dbFile);
  const noMail = await startServer(PORT_NO_MAIL, {}, path.join(os.tmpdir(), `journey-delete-test-b-${process.pid}.sqlite`));
  const BASE = `http://localhost:${PORT}`;
  const json = (method, p, body, token) =>
    fetch(BASE + p, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined })
      .then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

  const memoryRows = (id) => db.prepare("SELECT COUNT(*) AS n FROM ai_memory WHERE user_id = ?").get(id).n;
  const userRow = (email) => db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  /** Real sign-in through the real routes. Uses this email's one code request. */
  async function signUp(email, name) {
    const req = await json("POST", "/auth/request-code", { email });
    assert.equal(req.status, 200);
    const res = await json("POST", "/auth/verify-code", { email, code: req.data.devCode, name });
    assert.equal(res.status, 200);
    return res.data; // { token, user }
  }
  /** An existing account with three AI-history notes, made directly so it needs no code request. */
  function seedAccount(email) {
    const id = crypto.randomUUID();
    db.prepare("INSERT INTO users (id, email, name) VALUES (?, ?, ?)").run(id, email, email.split("@")[0]);
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO ai_memory (user_id, kind, content) VALUES (?, 'question', ?)").run(id, `note ${i}`);
    return id;
  }

  try {
    console.log("Legal pages");
    for (const [p, phrase] of [["/", "Your guide to places across India"], ["/privacy", "The short version"], ["/terms", "About Jourrrney"], ["/delete-account", "Delete your Jourrrney account"]]) {
      const r = await fetch(BASE + p);
      const html = await r.text();
      assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/html/); assert.match(html, new RegExp(phrase));
      assert.match(html, /name="viewport"/);
    }
    ok("/, /privacy, /terms and /delete-account are public pages (no sign-in needed)");
    const home = await (await fetch(BASE + "/")).text();
    assert.match(home, /<title>Jourrrney \| Travel guide for India<\/title>/); assert.match(home, /name="description"/);
    assert.match(home, /href="\/privacy"/); assert.match(home, /href="\/terms"/); assert.match(home, /href="\/delete-account"/);
    assert.doesNotMatch(home, /Sign in with email|email sign-in/i);
    ok("the home page has a title and description, says what the app does, and links to the privacy policy, terms and account deletion");
    const privacy = await (await fetch(BASE + "/privacy")).text();
    assert.match(privacy, /Last updated 26 October 2026/); assert.match(privacy, /do not sell your information/);
    assert.match(privacy, /mailto:help@example\.test/);
    ok("the privacy policy is dated, says we do not sell data, and shows the support address when one is set");
    const fallback = await (await fetch(`http://localhost:${PORT_NO_MAIL}/privacy`)).text();
    assert.doesNotMatch(fallback, /mailto:/); assert.match(fallback, /Google Play page/);
    ok("with no support address set, the policy points to the Google Play contact instead of leaving a blank");
    const del = await (await fetch(BASE + "/delete-account")).text();
    assert.match(del, /\/auth\/request-code/); assert.match(del, /\/auth\/delete-with-code/); assert.match(del, /cannot be undone/);
    ok("the delete page warns that it cannot be undone and uses the real endpoints");
    const fb = await (await fetch(BASE + "/auth/facebook/data-deletion")).text();
    assert.match(fb, /\/delete-account/); assert.match(fb, /help@example\.test/); assert.match(fb, /kept only on your phone/);
    ok("Meta's data-deletion page links to the delete page, shows the support address, and no longer claims we store saved trips");

    console.log("Deleting from inside the app");
    const alice = await signUp("alice@example.test", "Alice");
    const aliceSignedUpAt = Date.now();
    const bobId = seedAccount("bob@example.test");
    const bobToken = jwt.sign({ sub: bobId }, "test-secret", { expiresIn: "30d" });
    for (let i = 0; i < 3; i++) db.prepare("INSERT INTO ai_memory (user_id, kind, content) VALUES (?, 'question', ?)").run(alice.user.id, `note ${i}`);
    assert.equal((await json("GET", "/profile", null, alice.token)).status, 200);
    ok("signed-in Alice can read her profile");
    assert.equal((await json("DELETE", "/auth/account")).status, 401);
    ok("deleting without being signed in is refused");
    const gone = await json("DELETE", "/auth/account", null, alice.token);
    assert.equal(gone.status, 200); assert.equal(gone.data.ok, true);
    ok("Alice deletes her account");
    assert.equal(userRow("alice@example.test"), undefined); assert.equal(memoryRows(alice.user.id), 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM login_codes WHERE email = ?").get("alice@example.test").n, 0);
    ok("her user row, her AI history and any waiting sign-in code are all gone");
    assert.ok(userRow("bob@example.test")); assert.equal(memoryRows(bobId), 3);
    ok("Bob's account and AI history are untouched");
    for (const p of ["/profile", "/auth/me", "/ai-memory"]) assert.equal((await json("GET", p, null, alice.token)).status, 401, p);
    assert.equal((await json("GET", "/profile", null, bobToken)).status, 200);
    ok("Alice's old sign-in token stops working everywhere straight away; Bob's still works");
    assert.equal((await json("DELETE", "/auth/account", null, alice.token)).status, 401);
    ok("deleting twice with the old token is refused rather than crashing");
    const asGuestOrUser = (token) => { const req = { headers: { authorization: `Bearer ${token}` } }; optionalAuth(req, {}, () => {}); return req.userId; };
    assert.ok(jwt.verify(alice.token, "test-secret"));
    assert.equal(asGuestOrUser(alice.token), undefined); assert.equal(asGuestOrUser(bobToken), bobId);
    ok("her token is still validly signed, but the AI routes now treat it as a guest, so no history can be written for a deleted account");

    console.log("Deleting from the website");
    const noCode = await json("POST", "/auth/delete-with-code", { email: "bob@example.test", code: "000000" });
    assert.equal(noCode.status, 400); assert.match(noCode.data.error, /Request a new code/); assert.ok(userRow("bob@example.test"));
    ok("without asking for a code first, nothing can be deleted");
    assert.equal((await json("POST", "/auth/delete-with-code", { email: "not-an-email", code: "123456" })).status, 400);
    ok("a bad email address is refused");

    const askBob = await json("POST", "/auth/request-code", { email: "bob@example.test" });
    const wrongCode = askBob.data.devCode === "111111" ? "222222" : "111111";
    const wrong = await json("POST", "/auth/delete-with-code", { email: "bob@example.test", code: wrongCode });
    assert.equal(wrong.status, 400); assert.match(wrong.data.error, /Incorrect/); assert.ok(userRow("bob@example.test"));
    ok("a wrong code deletes nothing");

    const daveId = seedAccount("dave@example.test");
    const askDave = await json("POST", "/auth/request-code", { email: "dave@example.test" });
    for (let i = 0; i < 5; i++) await json("POST", "/auth/delete-with-code", { email: "dave@example.test", code: wrongCode });
    const locked = await json("POST", "/auth/delete-with-code", { email: "dave@example.test", code: askDave.data.devCode });
    assert.equal(locked.status, 429); assert.ok(userRow("dave@example.test")); assert.equal(memoryRows(daveId), 3);
    ok("guessing is limited: after 5 wrong tries even the right code is refused");

    const byWeb = await json("POST", "/auth/delete-with-code", { email: "Bob@Example.test", code: askBob.data.devCode });
    assert.equal(byWeb.status, 200); assert.equal(byWeb.data.ok, true);
    assert.equal(userRow("bob@example.test"), undefined); assert.equal(memoryRows(bobId), 0);
    assert.equal((await json("GET", "/profile", null, bobToken)).status, 401);
    ok("with the right emailed code (email typed in any capitals), Bob's account and AI history are deleted, and his phone is signed out");
    assert.ok(userRow("dave@example.test"));
    ok("Dave, who is a different person, was never touched");

    const ghost = await json("POST", "/auth/request-code", { email: "nobody@example.test" });
    const ghostDel = await json("POST", "/auth/delete-with-code", { email: "nobody@example.test", code: ghost.data.devCode });
    assert.equal(ghostDel.status, 404); assert.match(ghostDel.data.error, /Nothing was deleted/);
    ok("an address with no account gets a plain 'nothing was deleted' answer");

    const wait = 26000 - (Date.now() - aliceSignedUpAt);
    if (wait > 0) { console.log(`  ... waiting ${Math.ceil(wait / 1000)}s (one sign-in code per email every 25s) ...`); await sleep(wait); }
    const again = await signUp("alice@example.test", "Alice again");
    assert.notEqual(again.user.id, alice.user.id); assert.equal(memoryRows(again.user.id), 0);
    ok("the same email can sign up again later and gets a brand-new, empty account");

    console.log("\nAll " + n + " checks passed.");
  } finally {
    server.kill(); noMail.kill();
  }
}

main().catch((err) => { console.error("\nFAILED:", err.message); process.exit(1); });
