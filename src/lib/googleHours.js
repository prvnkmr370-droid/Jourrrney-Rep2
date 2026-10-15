/**
 * Opening hours from Google Maps (Places API "Text Search (New)").
 *
 * Needs GOOGLE_PLACES_API_KEY (a Google Cloud API key with the Places API
 * (New) enabled and billing attached). Without it isConfigured() is false
 * and the route answers 503, so the app falls back to its own curated hours.
 *
 * Google's terms: Places content may not be pre-fetched, cached or stored
 * (only place IDs may), and must carry Google attribution when shown without
 * a Google map. So this module is strictly a live pass-through: nothing is
 * written to SQLite or held between requests, and the app shows a
 * "Google Maps" credit next to the hours. Do not seed this into data files.
 */
const URL_SEARCH = process.env.GOOGLE_PLACES_API_URL || "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 10_000;
const MAX_DISTANCE_KM = 30;

function isConfigured() {
  return Boolean(process.env.GOOGLE_PLACES_API_KEY);
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\([^)]*\)/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Share of the wanted name's words (3+ letters) that appear in Google's name. */
function nameOverlap(wanted, found) {
  const words = norm(wanted).split(" ").filter((w) => w.length > 2);
  if (words.length === 0) return 0;
  const hay = ` ${norm(found)} `;
  return words.filter((w) => hay.includes(` ${w} `) || hay.includes(w)).length / words.length;
}

function haversineKm(a, b) {
  const R = 6371;
  const t = (d) => (d * Math.PI) / 180;
  const x = Math.sin(t(b.lat - a.lat) / 2) ** 2 + Math.cos(t(a.lat)) * Math.cos(t(b.lat)) * Math.sin(t(b.lon - a.lon) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
}

/**
 * Looks one place up. Resolves to null when Google has no confident match
 * (wrong name, too far from the destination's coordinates, or no published
 * hours) — better to show nothing than another place's timings.
 */
async function lookup({ name, state, lat, lon }) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");

  const body = { textQuery: [name, state, "India"].filter(Boolean).join(", "), regionCode: "IN", pageSize: 3 };
  const hasCoords = Number.isFinite(lat) && Number.isFinite(lon);
  if (hasCoords) body.locationBias = { circle: { center: { latitude: lat, longitude: lon }, radius: 25000 } };

  const res = await fetch(URL_SEARCH, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "places.id,places.displayName,places.location,places.regularOpeningHours",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const err = new Error(`Google Places responded ${res.status}`);
    err.detail = (await res.text().catch(() => "")).slice(0, 300);
    throw err;
  }
  const data = await res.json();

  let best = null;
  for (const p of data.places || []) {
    const placeName = p.displayName?.text || "";
    const days = p.regularOpeningHours?.weekdayDescriptions;
    if (!Array.isArray(days) || days.length !== 7) continue;
    if (nameOverlap(name, placeName) < 0.5) continue;
    if (hasCoords && p.location && haversineKm({ lat, lon }, { lat: p.location.latitude, lon: p.location.longitude }) > MAX_DISTANCE_KM) continue;
    best = { placeName, weekdayDescriptions: days.map((d) => String(d)) };
    break;
  }
  return best;
}

module.exports = { isConfigured, lookup, nameOverlap };
