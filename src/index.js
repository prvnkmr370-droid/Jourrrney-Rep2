require("dotenv").config();
const express = require("express");
const cors = require("cors");
const authRoutes = require("./routes/auth");
const profileRoutes = require("./routes/profile");
const placesRoutes = require("./routes/places");
const planTripRoutes = require("./routes/planTrip");

const app = express();
app.use(cors());
// Default express.json() body limit is ~100kb -- fine for every other
// route here, but POST /plan-trip/parse-intent can now carry a base64-
// encoded photo (see planTrip.js) that easily exceeds that. The app
// resizes/compresses images client-side before sending, so 8mb is a
// generous ceiling, not an expected typical size.
app.use(express.json({ limit: "8mb" }));

app.get("/health", (_req, res) => res.json({ ok: true }));
app.use("/auth", authRoutes);
app.use("/profile", profileRoutes);
app.use("/places", placesRoutes);
app.use("/plan-trip", planTripRoutes);

const PORT = process.env.PORT || 4000;
// Bind to 0.0.0.0, not just localhost — the Expo Go app on your phone
// needs to reach this over the LAN, same as the Metro dev server does.
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Journey backend listening on http://0.0.0.0:${PORT}`);
});
