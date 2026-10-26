/**
 * Verifies the Authorization: Bearer <token> header and attaches the
 * authenticated user's id as req.userId. Extracted from what was
 * previously inline-only logic in GET /auth/me, so /profile (and any
 * future authenticated routes) can reuse the same check instead of
 * re-implementing it.
 *
 * A valid token is not enough on its own: the account must still exist. A
 * deleted account's token stays cryptographically valid for up to 30 days, so
 * without this check it could keep working (and keep writing data) after the
 * person asked for everything to be removed.
 */
const jwt = require("jsonwebtoken");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");

const accountExists = db.prepare("SELECT 1 FROM users WHERE id = ?");

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in." });

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: "Session expired — sign in again.", code: "session_expired" });
  }
  // `code` lets the app tell "this account is already gone" (a delete has nothing left to do) from
  // "your sign-in ran out" (the account still exists, so it must not be reported as deleted).
  if (!accountExists.get(payload.sub)) return res.status(401).json({ error: "Account not found — sign in again.", code: "account_not_found" });
  req.userId = payload.sub;
  next();
}

module.exports = requireAuth;
