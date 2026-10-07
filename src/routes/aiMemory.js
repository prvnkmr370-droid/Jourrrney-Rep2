/**
 * A signed-in user's own AI history — what the app has remembered from their
 * earlier AI requests (see lib/aiMemory.js). Strictly per-user: every route
 * is scoped to req.userId from the session token.
 *
 * GET    /ai-memory       -> { entries: [{ id, kind, content, createdAt }] }  (newest first)
 * DELETE /ai-memory       -> clears everything this user has stored
 * DELETE /ai-memory/:id   -> removes a single entry
 */
const express = require("express");
const requireAuth = require("../middleware/requireAuth");
const { listMemory, deleteMemoryEntry, clearMemory } = require("../lib/aiMemory");

const router = express.Router();
router.use(requireAuth);

router.get("/", (req, res) => {
  res.json({ entries: listMemory(req.userId) });
});

router.delete("/", (req, res) => {
  res.json({ ok: true, deleted: clearMemory(req.userId) });
});

router.delete("/:id", (req, res) => {
  const id = Number.parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: "Invalid id." });
  if (!deleteMemoryEntry(req.userId, id)) return res.status(404).json({ error: "Not found." });
  res.json({ ok: true });
});

module.exports = router;
