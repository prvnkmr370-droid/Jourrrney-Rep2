/**
 * SQLite storage — a single file on disk (data.sqlite), zero external
 * services required. Fine for development and small-scale real use;
 * if this ever needs to run on more than one server instance at once,
 * swap this file for a real Postgres/MySQL client — the rest of the app
 * only talks to the functions exported here, not to SQLite directly.
 *
 * NOTE: on Render's free tier this file does not survive a redeploy (see
 * README.md) — the schema below still matters for local development,
 * where the file does persist across restarts.
 */
const path = require("node:path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "..", "data.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_codes (
    email TEXT PRIMARY KEY,
    code_hash TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0
  );
`);

// Lightweight migration: add profile columns to `users` if they don't
// already exist yet, so upgrading an existing local data.sqlite (created
// before this change) doesn't need a manual reset. CREATE TABLE IF NOT
// EXISTS above only handles brand-new databases.
const existingColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
const profileColumns = {
  bio: "TEXT",
  work: "TEXT",
  education: "TEXT",
  languages: "TEXT",
  location: "TEXT",
};
for (const [column, type] of Object.entries(profileColumns)) {
  if (!existingColumns.has(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} ${type}`);
  }
}

module.exports = db;
