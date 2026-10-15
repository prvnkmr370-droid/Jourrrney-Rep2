/**
 * "Places of interest near a destination" — sourced from OpenStreetMap via
 * the free public Overpass API (no API key, no billing account, unlike
 * Google Places).
 *
 * IMPORTANT: Render's free-tier egress IP gets ECONNREFUSED/ETIMEDOUT from
 * every public Overpass mirror we tried — Overpass instances actively
 * rate-limit/block requests from cloud-hosting IP ranges to stop scraper
 * abuse, and Render's range is caught by it. So live fetching cannot be
 * relied on from this deployment. To work around that: results for the
 * app's fixed destination list are pre-fetched from a machine that CAN
 * reach Overpass (see scripts/seed-places.js) and committed as static JSON
 * (src/data/placesSeed.json). That seed is what actually serves requests
 * in production; a live Overpass fetch is attempted first as a bonus (it
 * may well succeed for destinations outside the seeded set, or if Render's
 * network situation changes), falling back to the seed, then to SQLite
 * cache, in that order.
 *
 * GET /places?destinationId=agra&lat=27.1767&lon=78.0081[&radius=10000]
 *   destinationId — cache key, any stable string (the app's destination id)
 *   lat, lon      — the destination's center point
 *   radius        — search radius in metres, default 10km, capped at 25km
 */
const express = require("express");
const db = require("../db");
const { buildQuery, queryOverpassWithFallback, normalize } = require("../lib/overpass");
const placesSeed = require("../data/placesSeed.json");

const router = express.Router();

const CACHE_TTL_DAYS = 30; // OSM POI data for tourist attractions barely churns — safe to hold onto for a while
const DEFAULT_RADIUS_M = 10000;
const MAX_RADIUS_M = 25000;

function getCached(destinationId) {
  const row = db.prepare("SELECT payload, fetched_at FROM places_cache WHERE destination_id = ?").get(destinationId);
  if (!row) return null;
  const ageDays = (Date.now() - new Date(row.fetched_at).getTime()) / (1000 * 60 * 60 * 24);
  return { payload: JSON.parse(row.payload), fresh: ageDays < CACHE_TTL_DAYS };
}

function setCached(destinationId, places) {
  db.prepare(
    `INSERT INTO places_cache (destination_id, payload, fetched_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(destination_id) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
  ).run(destinationId, JSON.stringify(places));
}

// GET /places/hours?name=Rock%20Garden&state=Chandigarh&lat=30.75&lon=76.8
// Live opening hours from Google Maps (see lib/googleHours.js for the terms
// this is built around). 503 when no Google key is configured — the app then
// shows its own curated hours instead.
const googleHours = require("../lib/googleHours");
const hoursHits = new Map(); // ip -> request timestamps, to protect the billed API
const HOURS_PER_IP_PER_HOUR = 120;

router.get("/hours", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const name = String(req.query.name || "").trim().slice(0, 120);
  if (!name) return res.status(400).json({ error: "name is required" });
  if (!googleHours.isConfigured()) {
    return res.status(503).json({ error: "Google opening hours aren't configured on this server." });
  }

  const now = Date.now();
  const ip = req.ip || "unknown";
  const recent = (hoursHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= HOURS_PER_IP_PER_HOUR) return res.status(429).json({ error: "Too many requests — try again later." });
  recent.push(now);
  hoursHits.set(ip, recent);

  const lat = req.query.lat === undefined ? NaN : Number(req.query.lat);
  const lon = req.query.lon === undefined ? NaN : Number(req.query.lon);
  try {
    const hit = await googleHours.lookup({ name, state: String(req.query.state || "").slice(0, 80), lat, lon });
    if (!hit) return res.json({ found: false });
    res.json({ found: true, placeName: hit.placeName, weekdayDescriptions: hit.weekdayDescriptions, source: "Google Maps" });
  } catch (err) {
    console.error(`[places/hours] ${err.message}${err.detail ? ` — ${err.detail}` : ""}`);
    res.status(502).json({ error: "Couldn't load opening hours right now." });
  }
});

router.get("/", async (req, res) => {
  const { destinationId, lat, lon, radius } = req.query;
  if (!destinationId || !lat || !lon) {
    return res.status(400).json({ error: "destinationId, lat, and lon are required" });
  }
  const latNum = Number(lat);
  const lonNum = Number(lon);
  if (Number.isNaN(latNum) || Number.isNaN(lonNum)) {
    return res.status(400).json({ error: "lat and lon must be numbers" });
  }
  const radiusM = Math.min(Number(radius) || DEFAULT_RADIUS_M, MAX_RADIUS_M);

  const cached = getCached(destinationId);
  if (cached?.fresh) {
    return res.json({ places: cached.payload, source: "cache" });
  }

  try {
    const data = await queryOverpassWithFallback(buildQuery(latNum, lonNum, radiusM));
    const places = normalize(data.elements || [], latNum, lonNum);
    setCached(destinationId, places);
    return res.json({ places, source: "live" });
  } catch (err) {
    console.error("Overpass fetch failed on all mirrors:", err.message);
    // Live Overpass is unreliable from this host (see file header) — fall
    // back to the committed static seed for this destination, then to
    // whatever's in the SQLite cache (even stale), before giving up.
    if (placesSeed[destinationId]) {
      return res.json({ places: placesSeed[destinationId], source: "seed" });
    }
    if (cached) return res.json({ places: cached.payload, source: "stale-cache" });
    // `detail` is just an upstream HTTP status/timeout message, not
    // sensitive — useful for diagnosing Overpass outages/rate-limits
    // without needing server log access.
    return res.status(502).json({ error: "Could not fetch places right now — try again shortly", detail: err.message });
  }
});

module.exports = router;
