require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRoutes);
app.use("/profile", profileRoutes);

const PORT = process.env.PORT || 4000;
// Bind to 0.0.0.0, not just localhost — the Expo Go app on your phone
// needs to reach this over the LAN, same as the Metro dev server does.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Journey backend listening on http://0.0.0.0:${PORT}`);
});
