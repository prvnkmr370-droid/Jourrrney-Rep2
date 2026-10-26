/**
 * Deleting an account. Google Play (and Apple) require that anyone who can
 * create an account in the app can also delete it, together with the data tied
 * to it. Everything the server keeps about a person lives in three places:
 * their row in `users`, their `ai_memory` notes, and any sign-in code still
 * waiting for their email. All three go in one transaction, so a failure
 * leaves the account whole rather than half deleted.
 *
 * Their sign-in token (a 30-day JWT) cannot be taken back from the phone, so
 * requireAuth / optionalAuth also check the account still exists; that is what
 * makes a deletion take effect straight away.
 */
const db = require("../db");

const findById = db.prepare("SELECT id, email FROM users WHERE id = ?");
const findByEmail = db.prepare("SELECT id, email FROM users WHERE email = ?");

const removeEverything = db.transaction((user) => {
  db.prepare("DELETE FROM ai_memory WHERE user_id = ?").run(user.id);
  db.prepare("DELETE FROM login_codes WHERE email = ?").run(user.email);
  db.prepare("DELETE FROM users WHERE id = ?").run(user.id);
});

function deleteUser(user) {
  if (!user) return false;
  removeEverything(user);
  // Deliberately no email address in the log line: a deleted person's data should not live on in logs.
  console.log("[account] an account and its data were deleted");
  return true;
}

/** @returns {boolean} true if an account was found and deleted */
function deleteAccountById(userId) {
  return deleteUser(findById.get(userId));
}

/** @returns {boolean} true if an account was found and deleted */
function deleteAccountByEmail(email) {
  return deleteUser(findByEmail.get(String(email || "").trim().toLowerCase()));
}

module.exports = { deleteAccountById, deleteAccountByEmail };
