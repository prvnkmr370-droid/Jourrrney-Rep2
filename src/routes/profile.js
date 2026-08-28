/**
 * Real profile persistence for signed-in users — bio, languages,
 * location, themeMode. All optional/nullable; a brand-new account has
 * none of these set, and the app should show honest empty states rather
 * than any placeholder persona for real accounts.
 *
 * Work/Education were dropped (not relevant for a travel app) — the
 * `work`/`education` columns still exist in the users table (see db.js)
 * since dropping a SQLite column isn't worth the migration risk for two
 * now-unused nullable fields, but nothing reads or writes them anymore.
 */
const express = require("express");
const db = require("../db");
const requireAuth = require("../middleware/requireAuth");

const router = express.Router();

const EDITABLE_FIELDS = ["bio", "languages", "location", "themeMode"];
const MAX_FIELD_LENGTH = 500;
const VALID_THEME_MODES = new Set(["system", "light", "dark"]);
const PROFILE_COLUMNS = "id, email, name, bio, languages, location, themeMode";

router.use(requireAuth);

// GET /profile
router.get("/", (req, res) => {
  const user = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`).get(req.userId);
  if (!user) return res.status(404).json({ error: "Account not found." });
  res.json({ profile: user });
});

// PATCH /profile — accepts any subset of EDITABLE_FIELDS
router.patch("/", (req, res) => {
  const updates = {};
  for (const field of EDITABLE_FIELDS) {
    if (req.body?.[field] === undefined) continue;
    const value = req.body[field];

    if (field === "themeMode") {
      if (value !== null && !VALID_THEME_MODES.has(value)) {
        return res.status(400).json({ error: 'themeMode must be "system", "light", "dark", or null.' });
      }
      updates[field] = value;
      continue;
    }

    if (value !== null && typeof value !== "string") {
      return res.status(400).json({ error: `${field} must be text.` });
    }
    updates[field] = value === null ? null : value.trim().slice(0, MAX_FIELD_LENGTH);
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: "Nothing to update." });
  }

  const setClause = Object.keys(updates).map((f) => `${f} = @${f}`).join(", ");
  db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...updates, id: req.userId });

  const user = db.prepare(`SELECT ${PROFILE_COLUMNS} FROM users WHERE id = ?`).get(req.userId);
  res.json({ profile: user });
});

module.exports = router;
