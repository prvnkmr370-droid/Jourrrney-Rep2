/**
 * End-to-end check of who may use the AI. By default a guest cannot (sign-in required); with AI_GUEST_PROMPT_LIMIT
 * set to a number a guest gets that many free prompts first. Both modes are checked:
 *
 *   node scripts/test-ai-guest-limit.js
 *
 * Starts the real server twice as child processes on a throwaway SQLite file (data.sqlite is untouched), with a
 * stand-in for the AI provider, so nothing leaves this machine and no AI key is needed or spent.
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const AI_PORT = 4510, MAIN_PORT = 4511, CAP_PORT = 4512, LOGIN_PORT = 4513;
const dbFile = path.join(os.tmpdir(), `journey-ai-limit-test-${process.pid}.sqlite`);
const capDbFile = path.join(os.tmpdir(), `journey-ai-limit-cap-test-${process.pid}.sqlite`);
const loginDbFile = path.join(os.tmpdir(), `journey-ai-limit-login-test-${process.pid}.sqlite`);

/* ---- a fake AI (answers like Anthropic's Messages API) ---- */
let aiCalls = 0, aiFailNext = false;
const ANSWER = {
  destinationId: "jaipur", outsideIndia: false, recognizedIndianPlace: false, recognizedPlaceName: null, days: 3, people: 2, style: "comfortable", interests: [], reasoning: "ok",
  itinerary: [{ day: 1, title: "Day 1", morning: "m", afternoon: "a", evening: "e", estimatedCost: 1500, stops: [] }], tips: ["t"],
  distanceKm: 300, transport: [{ mode: "Train", duration: "5h", costRange: "x", details: "d", tips: "t" }],
};
const ai = http.createServer((req, res) => {
  let body = "";
  req.on("data", (d) => (body += d));
  req.on("end", () => {
    aiCalls++;
    res.setHeader("Content-Type", "application/json");
    if (aiFailNext) { aiFailNext = false; res.statusCode = 500; return res.end("{}"); }
    res.end(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(ANSWER) }] }));
  });
});

/* ---- servers ---- */
function start(port, db, extraEnv) {
  const child = spawn(process.execPath, [path.join(__dirname, "..", "src", "index.js")], {
    env: {
      ...process.env, PORT: String(port), SQLITE_PATH: db, NODE_ENV: "development", RENDER: "",
      ANTHROPIC_API_KEY: "test-key", ANTHROPIC_API_URL: `http://127.0.0.1:${AI_PORT}/v1/messages`, GEMINI_API_KEY: "", GROQ_API_KEY: "", ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", () => {}); child.stdout.on("data", () => {});
  return child;
}
async function waitUp(port) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server on ${port} did not start`);
}

const uuid = () => crypto.randomUUID();
const DESTS = [{ id: "jaipur", name: "Jaipur", state: "Rajasthan", tagline: "Pink City", category: ["Heritage"] }];
const bodies = {
  "parse-intent": { message: "3 days in Jaipur", destinations: DESTS },
  ai: { destination: { name: "Jaipur", state: "Rajasthan" }, style: { label: "Comfortable" }, days: 2, people: 2 },
  "route-info": { origin: "Delhi", destination: { name: "Jaipur", state: "Rajasthan" } },
};
async function call(port, route, { device, prompt, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (device) headers["X-Device-Id"] = device;
  if (prompt) headers["X-AI-Prompt-Id"] = prompt;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}/plan-trip/${route}`, { method: "POST", headers, body: JSON.stringify(bodies[route]) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function access(port, { device, token } = {}) {
  const headers = {};
  if (device) headers["X-Device-Id"] = device;
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`http://127.0.0.1:${port}/plan-trip/ai-access`, { headers });
  return { status: r.status, body: await r.json() };
}

let n = 0, failed = 0;
async function check(name, fn) {
  n++;
  try { await fn(); console.log(`ok ${n} - ${name}`); } catch (e) { failed++; console.log(`NOT OK ${n} - ${name}\n    ${e.message}`); }
}

(async () => {
  await new Promise((r) => ai.listen(AI_PORT, "127.0.0.1", r));
  // main and cap: the optional "free taste" mode (5 free prompts). login: the default, sign-in required.
  const main = start(MAIN_PORT, dbFile, { AI_GUEST_PROMPT_LIMIT: "5", AI_GUEST_IP_DAILY_CAP: "1000" });
  const cap = start(CAP_PORT, capDbFile, { AI_GUEST_PROMPT_LIMIT: "5", AI_GUEST_IP_DAILY_CAP: "3" });
  const login = start(LOGIN_PORT, loginDbFile, { AI_GUEST_PROMPT_LIMIT: "" });
  try {
    await waitUp(MAIN_PORT); await waitUp(CAP_PORT); await waitUp(LOGIN_PORT);

    const A = uuid(), B = uuid(), C = uuid();

    await check("a new phone has 5 free AI prompts and no AI call is made to find out", async () => {
      const before = aiCalls;
      const r = await access(MAIN_PORT, { device: A });
      assert.deepEqual(r.body, { signedIn: false, used: 0, limit: 5, remaining: 5 });
      assert.equal(aiCalls, before);
    });

    await check("five different prompts are answered, and each says how many are left", async () => {
      for (let i = 0; i < 5; i++) {
        const r = await call(MAIN_PORT, "parse-intent", { device: A, prompt: uuid() });
        assert.equal(r.status, 200, `prompt ${i + 1}`);
        assert.deepEqual(r.body.guest, { used: i + 1, limit: 5, remaining: 4 - i });
        assert.equal(r.body.destinationId, "jaipur", "the answer itself is unchanged");
      }
    });

    await check("the sixth prompt is refused with a clear code, and the AI is not called for it", async () => {
      const before = aiCalls;
      const r = await call(MAIN_PORT, "parse-intent", { device: A, prompt: uuid() });
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "guest_limit");
      assert.equal(r.body.limit, 5);
      assert.match(r.body.error, /free AI prompts/);
      assert.equal(aiCalls, before);
    });

    await check("trip planning and route details are limited too, not only the chat", async () => {
      assert.equal((await call(MAIN_PORT, "ai", { device: A, prompt: uuid() })).status, 403);
      assert.equal((await call(MAIN_PORT, "route-info", { device: A, prompt: uuid() })).status, 403);
    });

    await check("the access check shows none left", async () => {
      assert.deepEqual((await access(MAIN_PORT, { device: A })).body, { signedIn: false, used: 5, limit: 5, remaining: 0 });
    });

    await check("several calls for one prompt (a trip with several stops) count as one prompt", async () => {
      const p = uuid();
      for (let i = 0; i < 3; i++) assert.equal((await call(MAIN_PORT, "ai", { device: B, prompt: p })).status, 200);
      assert.equal((await access(MAIN_PORT, { device: B })).body.used, 1);
    });

    await check("a prompt that was already counted can still finish when none are left", async () => {
      const p = uuid();
      for (let i = 0; i < 5; i++) await call(MAIN_PORT, "parse-intent", { device: C, prompt: i === 4 ? p : uuid() });
      assert.equal((await access(MAIN_PORT, { device: C })).body.remaining, 0);
      const again = await call(MAIN_PORT, "ai", { device: C, prompt: p });
      assert.equal(again.status, 200);
      assert.equal(again.body.guest.used, 5);
    });

    await check("each phone has its own count", async () => {
      assert.equal((await access(MAIN_PORT, { device: uuid() })).body.remaining, 5);
    });

    await check("an AI failure is not counted against the person", async () => {
      const D = uuid();
      aiFailNext = true;
      const bad = await call(MAIN_PORT, "parse-intent", { device: D, prompt: uuid() });
      assert.ok(bad.status >= 500, `got ${bad.status}`);
      assert.equal((await access(MAIN_PORT, { device: D })).body.used, 0);
      assert.equal((await call(MAIN_PORT, "parse-intent", { device: D, prompt: uuid() })).status, 200);
      assert.equal((await access(MAIN_PORT, { device: D })).body.used, 1);
    });

    await check("a call with no phone id (an old app, or a script) is counted by its network address and still limited", async () => {
      for (let i = 0; i < 5; i++) assert.equal((await call(MAIN_PORT, "parse-intent", {})).status, 200, `call ${i + 1}`);
      const r = await call(MAIN_PORT, "parse-intent", {});
      assert.equal(r.status, 403);
      assert.equal(r.body.code, "guest_limit");
    });

    await check("a made-up phone id is treated the same as none", async () => {
      assert.equal((await call(MAIN_PORT, "parse-intent", { device: "not-a-real-id" })).status, 403);
    });

    // a signed-in person
    let token;
    await check("someone can sign in (email code, development server)", async () => {
      const email = `limit-test-${process.pid}@example.test`;
      const rc = await (await fetch(`http://127.0.0.1:${MAIN_PORT}/auth/request-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, mode: "signup", firstName: "Test", lastName: "Person", ageConfirmed: true }) })).json();
      assert.ok(rc.devCode, "development server hands back the code");
      const vc = await (await fetch(`http://127.0.0.1:${MAIN_PORT}/auth/verify-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code: rc.devCode }) })).json();
      assert.ok(vc.token);
      token = vc.token;
    });

    await check("a signed-in person is not limited, even on a phone that used up its free prompts, and gets no counter", async () => {
      for (let i = 0; i < 8; i++) {
        const r = await call(MAIN_PORT, "parse-intent", { device: A, prompt: uuid(), token });
        assert.equal(r.status, 200, `signed-in call ${i + 1}`);
        assert.equal(r.body.guest, undefined);
      }
      assert.deepEqual((await access(MAIN_PORT, { device: A, token })).body, { signedIn: true });
    });

    await check("signing out brings the phone back to the same count it had", async () => {
      assert.equal((await call(MAIN_PORT, "parse-intent", { device: A, prompt: uuid() })).status, 403);
    });

    await check("a bad sign-in token is just a guest", async () => {
      const r = await call(MAIN_PORT, "parse-intent", { device: A, prompt: uuid(), token: "not.a.token" });
      assert.equal(r.status, 403);
    });

    await check("the other things the server does are not limited", async () => {
      for (const p of ["/health", "/places/search?q=jaipur"]) {
        const r = await fetch(`http://127.0.0.1:${MAIN_PORT}${p}`);
        assert.notEqual(r.status, 403, p);
      }
    });

    // the network-address safety net, on the second server (cap 3 a day)
    await check("changing the phone id on every call does not get around it (network address cap)", async () => {
      for (let i = 0; i < 3; i++) assert.equal((await call(CAP_PORT, "parse-intent", { device: uuid(), prompt: uuid() })).status, 200, `call ${i + 1}`);
      const r = await call(CAP_PORT, "parse-intent", { device: uuid(), prompt: uuid() });
      assert.equal(r.status, 429);
      assert.equal(r.body.code, "guest_ip_limit");
    });

    await check("the network address cap does not apply to someone signed in", async () => {
      const email = `limit-test-cap-${process.pid}@example.test`;
      const rc = await (await fetch(`http://127.0.0.1:${CAP_PORT}/auth/request-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, mode: "signup", firstName: "Test", lastName: "Person", ageConfirmed: true }) })).json();
      const vc = await (await fetch(`http://127.0.0.1:${CAP_PORT}/auth/verify-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code: rc.devCode }) })).json();
      assert.equal((await call(CAP_PORT, "parse-intent", { prompt: uuid(), token: vc.token })).status, 200);
    });

    // ---- the default: the AI needs sign-in (no AI_GUEST_PROMPT_LIMIT set) ----
    await check("DEFAULT: a guest is refused on all three AI routes, with a clear code, and no AI is called", async () => {
      const before = aiCalls;
      const phone = uuid();
      for (const route of ["parse-intent", "ai", "route-info"]) {
        const r = await call(LOGIN_PORT, route, { device: phone, prompt: uuid() });
        assert.equal(r.status, 403, route);
        assert.equal(r.body.code, "login_required", route);
        assert.match(r.body.error, /Sign in/, route);
      }
      assert.equal(aiCalls, before, "no AI provider was called");
    });

    await check("DEFAULT: it makes no difference whether the guest sends a phone id, a made-up one, or none", async () => {
      for (const device of [uuid(), "not-a-real-id", undefined]) {
        assert.equal((await call(LOGIN_PORT, "parse-intent", { device })).status, 403);
      }
    });

    await check("DEFAULT: repeating the call never gets through", async () => {
      const phone = uuid();
      for (let i = 0; i < 8; i++) assert.equal((await call(LOGIN_PORT, "parse-intent", { device: phone, prompt: uuid() })).status, 403, `call ${i + 1}`);
    });

    await check("DEFAULT: a bad or made-up sign-in token is just a guest", async () => {
      assert.equal((await call(LOGIN_PORT, "parse-intent", { token: "not.a.token" })).status, 403);
      const forged = [Buffer.from('{"alg":"none"}').toString("base64url"), Buffer.from('{"userId":1}').toString("base64url"), ""].join(".");
      assert.equal((await call(LOGIN_PORT, "ai", { token: forged })).status, 403);
    });

    await check("DEFAULT: the access check tells a guest to sign in, and calls no AI", async () => {
      const before = aiCalls;
      assert.deepEqual((await access(LOGIN_PORT, { device: uuid() })).body, { signedIn: false, used: 0, limit: 0, remaining: 0 });
      assert.equal(aiCalls, before);
    });

    await check("DEFAULT: a signed-in person can use all three AI routes, with no counter attached", async () => {
      const email = `login-required-${process.pid}@example.test`;
      const rc = await (await fetch(`http://127.0.0.1:${LOGIN_PORT}/auth/request-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, mode: "signup", firstName: "Test", lastName: "Person", ageConfirmed: true }) })).json();
      assert.ok(rc.devCode, "development server hands back the code");
      const vc = await (await fetch(`http://127.0.0.1:${LOGIN_PORT}/auth/verify-code`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, code: rc.devCode }) })).json();
      assert.ok(vc.token);
      const before = aiCalls;
      for (const route of ["parse-intent", "ai", "route-info"]) {
        const r = await call(LOGIN_PORT, route, { prompt: uuid(), token: vc.token });
        assert.equal(r.status, 200, route);
        assert.equal(r.body.guest, undefined, route);
      }
      assert.equal(aiCalls, before + 3);
      assert.deepEqual((await access(LOGIN_PORT, { token: vc.token })).body, { signedIn: true });
    });

    await check("DEFAULT: everything that is not AI is still open to a guest", async () => {
      for (const p of ["/health", "/places/search?q=jaipur", "/privacy", "/terms"]) {
        const r = await fetch(`http://127.0.0.1:${LOGIN_PORT}${p}`);
        assert.notEqual(r.status, 403, p);
        assert.notEqual(r.status, 401, p);
      }
    });
  } finally {
    main.kill(); cap.kill(); login.kill(); ai.close();
    for (const f of [dbFile, capDbFile, loginDbFile]) for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(f + suffix, { force: true });
  }
  console.log(failed ? `\n${failed} of ${n} checks FAILED` : `\nall ${n} checks passed`);
  process.exit(failed ? 1 : 0);
})();
