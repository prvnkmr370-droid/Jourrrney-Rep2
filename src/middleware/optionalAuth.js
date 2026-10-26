/**
 * Like requireAuth, but never rejects: if a valid Authorization: Bearer
 * <token> header is present it sets req.userId, otherwise the request just
 * continues as a guest. Used on the AI routes, which stay open to guests but
 * personalise (and remember requests) for signed-in users.
 *
 * A token whose account has been deleted counts as a guest too, so a deleted
 * person's old token cannot write new "memory" rows for an account that no
 * longer exists.
 */
const jwt = require("jsonwebtoken");
const db = require("../db");
const { JWT_SECRET } = require("../auth-config");

const accountExists = db.prepare("SELECT 1 FROM users WHERE id = ?");

function optionalAuth(req, _res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) {
    try {
      const { sub } = jwt.verify(token, JWT_SECRET);
      if (accountExists.get(sub)) req.userId = sub;
    } catch {
      // expired/invalid token: treat as a guest rather than failing the AI call
    }
  }
  next();
}

module.exports = optionalAuth;
