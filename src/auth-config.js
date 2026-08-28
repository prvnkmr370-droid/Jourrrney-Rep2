// Shared between routes/auth.js and middleware/requireAuth.js — was
// previously a local constant duplicated only in auth.js.
const JWT_SECRET = process.env.JWT_SECRET || "dev-only-secret-change-me";

module.exports = { JWT_SECRET };
