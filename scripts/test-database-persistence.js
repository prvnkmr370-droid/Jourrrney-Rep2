/**
 * Checks that the database survives a server restart, which is what a persistent disk gives on a host:
 *
 *   node scripts/test-database-persistence.js
 *
 * Starts the real server on a throwaway SQLite file (in a folder that does not exist yet, so the server must
 * create it), makes an account through the real routes, STOPS the server, starts a NEW one on the same file,
 * and checks the account is still there and GET /health/database says the file was kept. Nothing leaves this
 * machine and data.sqlite is untouched.
 */
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const PORT = 4520;
const dir = path.join(os.tmpdir(), `journey-persist-test-${process.pid}`, "nested", "disk");
const dbFile = path.join(dir, "data.sqlite");

function start(extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    env: { ...process.env, PORT: String(PORT), SQLITE_PATH: dbFile, JWT_SECRET: "test-secret", NODE_ENV: "development", RENDER: "", GEMINI_API_KEY: "", GROQ_API_KEY: "", ANTHROPIC_API_KEY: "", ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  child.getLog = () => log;
  return child;
}
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("server did not start");
}
const stop = (child) => new Promise((resolve) => { child.once("exit", resolve); child.kill(); });
const api = (p, body) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined)
    .then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));

let n = 0, failed = 0;
async function check(name, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${name}`); } catch (e) { failed++; console.log(`NOT OK ${n} - ${name}\n    ${e.message}`); }
}

(async () => {
  assert.ok(!fs.existsSync(dir), "the test starts with no folder");
  let server = start();
  let before, userId;
  try {
    await waitUp();

    await check("the server creates the folder for the database file if it is missing", async () => {
      assert.ok(fs.existsSync(dbFile));
    });

    await check("a brand-new database says so: first start, path configured", async () => {
      const r = await api("/health/database");
      assert.equal(r.status, 200);
      assert.equal(r.json.serverStarts, 1);
      assert.equal(r.json.pathConfigured, true);
      assert.ok(!Number.isNaN(Date.parse(r.json.createdAt)));
      assert.deepEqual(Object.keys(r.json).sort(), ["createdAt", "pathConfigured", "serverStarts"], "no personal data in it");
      before = r.json;
    });

    await check("someone creates an account (name, 18+, emailed code)", async () => {
      const email = "keeper@example.test";
      const rc = await api("/auth/request-code", { email, mode: "signup", firstName: "Kia", lastName: "Keeper", ageConfirmed: true });
      assert.equal(rc.status, 200);
      const vc = await api("/auth/verify-code", { email, code: rc.json.devCode });
      assert.equal(vc.status, 200);
      userId = vc.json.user.id;
      assert.equal(vc.json.user.name, "Kia Keeper");
    });

    await stop(server);
    server = start();
    await waitUp();

    await check("after a restart the same database file is in use: same creation time, one more start", async () => {
      const r = await api("/health/database");
      assert.equal(r.json.createdAt, before.createdAt);
      assert.equal(r.json.serverStarts, 2);
    });

    await check("after the restart the account is still there: signing in works and is the same account", async () => {
      const rc = await api("/auth/request-code", { email: "keeper@example.test" });
      assert.equal(rc.status, 200, "a sign-in for a kept account is not answered 'no account'");
      const vc = await api("/auth/verify-code", { email: "keeper@example.test", code: rc.json.devCode });
      assert.equal(vc.status, 200);
      assert.equal(vc.json.user.id, userId);
      assert.equal(vc.json.user.firstName, "Kia");
      assert.equal(vc.json.user.lastName, "Keeper");
    });

    await stop(server);
    server = start();
    await waitUp();

    await check("a second restart counts again, and the creation time never changes", async () => {
      const r = await api("/health/database");
      assert.equal(r.json.createdAt, before.createdAt);
      assert.equal(r.json.serverStarts, 3);
    });

    await check("on Render WITH a path set there is no temporary-storage warning", async () => {
      await stop(server);
      server = start({ RENDER: "true" });
      await waitUp();
      assert.ok(!/temporary storage/i.test(server.getLog()), "no warning when SQLITE_PATH is set");
    });
  } finally {
    await stop(server).catch(() => {});
    fs.rmSync(path.join(os.tmpdir(), `journey-persist-test-${process.pid}`), { recursive: true, force: true });
  }
  console.log(failed ? `\n${failed} of ${n} checks FAILED` : `\nall ${n} checks passed`);
  process.exit(failed ? 1 : 0);
})();
