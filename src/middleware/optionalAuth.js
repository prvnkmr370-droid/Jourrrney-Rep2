/**
 * Like requireAuth, but never rejects: if a valid Authorization: Bearer
 * <token> header is present it sets req.userId, otherwise the request just
 * continues as a guest. Used on the AI routes, which stay open to guests but
 * personalise (and remember requests) for signed-in users.
 */
const jwt = require("jsonwebtoken");
const { JWT_SECRET } = require("../auth-config");

function optionalAuth(req, _res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (token) {
    try {
      req.userId = jwt.verify(token, JWT_SECRET).sub;
    } catch {
      // expired/invalid token: treat as a guest rather than failing the AI call
    }
  }
  next();
}

module.exports = optionalAuth;
