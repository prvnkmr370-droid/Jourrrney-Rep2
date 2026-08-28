/**
 * Verifies the Authorization: Bearer <token> header and attaches the
 * authenticated user's id as req.userId. Extracted from what was
 * previously inline-only logic in GET /auth/me, so /profile (and any
 * future authenticated routes) can reuse the same check instead of
 * re-implementing it.
 */
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../auth-config");

function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not signed in." });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: "Session expired — sign in again." });
  }
}

module.exports = requireAuth;
