/**
 * SQLite storage — a single file on disk (data.sqlite), zero external
 * services required. Fine for development and small-scale real use;
 * if this ever needs to run on more than one server instance at once,
 * swap this file for a real Postgres/MySQL client — the rest of the app
 * only talks to the functions exported here, not to SQLite directly.
 *
 * WHERE THE FILE LIVES MATTERS ON A HOST. On Render, only a persistent disk
 * survives a restart or redeploy: the rest of the filesystem, including the
 * default data.sqlite next to the code, is wiped each time, and every account
 * goes with it. So on Render, attach a disk and point SQLITE_PATH at a file on
 * it (README.md, "Keeping the database across restarts"). GET /health/database
 * shows whether the file has survived (see the meta table below).
 */
const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

// SQLITE_PATH puts the database somewhere else: on a hosted server it must be a path on a persistent disk,
// and the tests (scripts/test-email-flow.js) use it for a throwaway file.
const dbPath = process.env.SQLITE_PATH || path.join(__dirname, "..", "data.sqlite");
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (process.env.RENDER === "true" && !process.env.SQLITE_PATH) {
  // Said loudly, once per start, in the host's logs: this is the "all accounts vanish on every deploy" setup.
  console.warn("[db] WARNING: running on Render without SQLITE_PATH, so the database is on temporary storage and ALL ACCOUNTS ARE LOST on every restart or deploy. Attach a persistent disk and set SQLITE_PATH to a file on it (see README.md).");
}
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Facts about this database file itself: when it was first made and how many times a server has started on
  -- it. If a restart brings them back to "just now" and 1, the file was NOT kept (GET /health/database).
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Reports of an AI reply or an AI-written plan, sent from the app's "Report" button (routes/reports.js).
  -- Deleted with the person's account (lib/accountDeletion.js).
  CREATE TABLE IF NOT EXISTS ai_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    reason TEXT NOT NULL,
    comment TEXT,
    content TEXT NOT NULL,
    context TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );

  -- Cache of OpenStreetMap/Overpass "places of interest" results per
  -- destination, so the free public Overpass instance (rate-limited, and
  -- slow — a few seconds per query) is hit at most once every
  -- CACHE_TTL_DAYS per destination, not on every user's page view. See
  -- routes/places.js.
  -- Per-user memory of earlier AI requests (see lib/aiMemory.js). Saved
  -- automatically for signed-in users only, read back only into that same
  -- user's prompts, and deletable via routes/aiMemory.js.
  CREATE TABLE IF NOT EXISTS ai_memory (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ai_memory_user ON ai_memory (user_id, id);

  -- Free AI prompts used by people who are not signed in (see middleware/aiGuestLimit.js).
  -- One row per prompt, keyed by the phone's random id (or its network address when it sent none);
  -- a prompt that needs several AI calls (a trip with several stops) is still one row.
  CREATE TABLE IF NOT EXISTS ai_guest_prompts (
    device_key TEXT NOT NULL,
    prompt_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (device_key, prompt_id)
  );

  CREATE TABLE IF NOT EXISTS places_cache (
    destination_id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );
`);

// Lightweight migration: add profile columns to `users` if they don't
// already exist yet, so upgrading an existing local data.sqlite (created
// before this change) doesn't need a manual reset. CREATE TABLE IF NOT
// EXISTS above only handles brand-new databases.
const existingColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
const profileColumns = {
  bio: "TEXT",
  // work/education: kept here (still created for a fresh DB) but no
  // longer read or written by routes/profile.js — dropped as not
  // relevant for a travel app. Left in the schema rather than migrated
  // out, since dropping a SQLite column isn't worth the risk for two
  // already-unused nullable fields.
  work: "TEXT",
  education: "TEXT",
  languages: "TEXT",
  location: "TEXT",
  // Named to match the app's TS field 1:1 (camelCase, not snake_case) —
  // SQLite doesn't care about column-naming convention, and it keeps this
  // one field simple to add to the generic EDITABLE_FIELDS loop in
  // routes/profile.js without a translation layer. Value is one of
  // "system" | "light" | "dark" (validated in profile.js, not here) —
  // NULL means "no saved preference yet, follow local default (system)".
  themeMode: "TEXT",
};
for (const [column, type] of Object.entries(profileColumns)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
  }
}

// Details collected when someone creates an account with their email (see routes/auth.js):
// first and last name, and the moment they confirmed they are 18 or over. Accounts made
// earlier, or through Google or Facebook, leave these empty.
const accountColumns = { first_name: "TEXT", last_name: "TEXT", age_confirmed_at: "TEXT" };
for (const [column, type] of Object.entries(accountColumns)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
  }
}
// The details typed on the sign-up form wait here, next to the emailed code, until the code is
// confirmed: only then is the account made.
const loginCodeColumns = new Set(db.prepare("PRAGMA table_info(login_codes)").all().map((c) => c.name));
if (!loginCodeColumns.has("signup_json")) {
  db.exec("ALTER TABLE login_codes ADD COLUMN signup_json TEXT");
}

db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', ?)").run(new Date().toISOString());
db.prepare("INSERT INTO meta (key, value) VALUES ('server_starts', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();

module.exports = db;
