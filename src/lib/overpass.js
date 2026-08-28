/**
 * Shared OpenStreetMap/Overpass query logic — used by both the live
 * /places route (routes/places.js) and the offline seed generator
 * (scripts/seed-places.js). Kept dependency-free (no express, no db) so
 * the seed script can require it standalone.
 */

// Multiple public Overpass mirrors, tried in order — the main instance
// (overpass-api.de) is known to hard-refuse connections from some cloud
// hosting IP ranges (confirmed from Render's free tier in testing), so a
// single-endpoint setup fails outright for those deployments.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
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

// Tries each Overpass mirror in turn, returning the first successful JSON
// response. Throws (with all per-endpoint failures joined together) only
// if every mirror fails.
async function queryOverpassWithFallback(query) {
  const failures = [];
  for (const endpoint of OVERPASS_ENDPOINTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      // Overpass expects the query as a urlencoded `data` form field — a
      // raw text/plain body gets rejected with 406 Not Acceptable. Its
      // Apache front-end also 406s requests with no Accept/User-Agent
      // header (Node's fetch sends neither by default), so both are set
      // explicitly here.
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Accept": "*/*",
          "User-Agent": "journey-backend/1.0 (jourrrney travel app; places lookup)",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`responded ${response.status}`);
      return await response.json();
    } catch (err) {
      clearTimeout(timeout);
      const causeMsg = err.cause ? ` (${err.cause.code || err.cause.message || err.cause})` : "";
      failures.push(`${new URL(endpoint).hostname}: ${err.message}${causeMsg}`);
    }
  }
  throw new Error(failures.join("; "));
}

module.exports = { buildQuery, normalize, queryOverpassWithFallback };
