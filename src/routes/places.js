/**
 * "Places of interest near a destination" — sourced from OpenStreetMap via
 * the free public Overpass API (no API key, no billing account, unlike
 * Google Places). Trade-off: Overpass is a shared community instance —
 * slower (a few seconds per query) and lightly rate-limited — so results
 * are cached in SQLite per destination (see places_cache in db.js) and
 * only refetched once the cache goes stale.
 *
 * GET /places?destinationId=agra&lat=27.1767&lon=78.0081[&radius=10000]
 *   destinationId — cache key, any stable string (the app's destination id)
 *   lat, lon      — the destination's center point
 *   radius        — search radius in metres, default 10km, capped at 25km
 */
const express = require("express");
const db = require("../db");

const router = express.Router();

const OVERPASS_ENDPOINT = "https://overpass-api.de/api/interpreter";
const CACHE_TTL_DAYS = 30; // OSM POI data for tourist attractions barely churns — safe to hold onto for a while
const DEFAULT_RADIUS_M = 10000;
const MAX_RADIUS_M = 25000;
const MAX_RESULTS = 20;
const FETCH_TIMEOUT_MS = 20000;

// Deliberately narrow set of tags — "what a leisure traveller would want to
// see on a destination page," not every shop/amenity OSM happens to have.
function buildQuery(lat, lon, radius) {
  return `
    [out:json][timeout:25];
    (
      nwr["tourism"~"^(attraction|museum|viewpoint|gallery|artwork|zoo)$"](around:${radius},${lat},${lon});
      nwr["historic"](around:${radius},${lat},${lon});
      nwr["natural"="beach"](around:${radius},${lat},${lon});
      nwr["leisure"="nature_reserve"](around:${radius},${lat},${lon});
    );
    out center tags;
  `;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function categoryFor(tags) {
  if (tags.natural === "beach") return "Beach";
  if (tags.tourism === "museum") return "Museum";
  if (tags.tourism === "viewpoint") return "Viewpoint";
  if (tags.tourism === "gallery") return "Art Gallery";
  if (tags.tourism === "zoo") return "Zoo";
  if (tags.tourism === "artwork") return "Landmark";
  if (tags.leisure === "nature_reserve") return "Nature Reserve";
  if (tags.historic) return "Historic Site";
  return "Attraction";
}

// Turns raw Overpass elements into a clean, deduped, distance-sorted list.
// Unnamed OSM features (there are usually many — random benches, unnamed
// footpaths tagged historic=yes, etc.) are dropped since they're not
// useful to show a traveller.
function normalize(elements, originLat, originLon) {
  const seen = new Set();
  const places = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const name = tags.name;
    if (!name) continue;
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    places.push({
      id: `${el.type}/${el.id}`,
      name,
      category: categoryFor(tags),
      lat,
      lon,
      distanceKm: Math.round(haversineKm(originLat, originLon, lat, lon) * 10) / 10,
      wikidata: tags.wikidata ?? null,
    });
  }
  return places.sort((a, b) => a.distanceKm - b.distanceKm).slice(0, MAX_RESULTS);
}

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    // Overpass expects the query as a urlencoded `data` form field — a
    // raw text/plain body gets rejected with 406 Not Acceptable. Its
    // Apache front-end also 406s requests with no Accept/User-Agent
    // header (Node's fetch sends neither by default), so both are set
    // explicitly here.
    const response = await fetch(OVERPASS_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "*/*",
        "User-Agent": "journey-backend/1.0 (jourrrney travel app; places lookup)",
      },
      body: `data=${encodeURIComponent(buildQuery(latNum, lonNum, radiusM))}`,
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) throw new Error(`Overpass responded ${response.status}`);
    const data = await response.json();
    const places = normalize(data.elements || [], latNum, lonNum);
    setCached(destinationId, places);
    return res.json({ places, source: "live" });
  } catch (err) {
    const causeMsg = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
    console.error("Overpass fetch failed:", err.message + causeMsg);
    // The public Overpass instance is free but shared and occasionally
    // rate-limits or times out — fall back to whatever's cached (even
    // stale) rather than fail the request outright.
    if (cached) return res.json({ places: cached.payload, source: "stale-cache" });
    // `detail` is just an upstream HTTP status/timeout message, not
    // sensitive — useful for diagnosing Overpass outages/rate-limits
    // without needing server log access.
    return res.status(502).json({ error: "Could not fetch places right now — try again shortly", detail: err.message + causeMsg });
  }
});

module.exports = router;
