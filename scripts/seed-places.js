/**
 * One-time (and re-runnable) seed generator for src/data/placesSeed.json.
 *
 * Why this exists: Render's free-tier egress IP gets ECONNREFUSED/ETIMEDOUT
 * from every public Overpass mirror we tried (overpass-api.de,
 * overpass.kumi.systems, overpass.private.coffee) — a known real limitation
 * where Overpass instances rate-limit/block requests from cloud-hosting IP
 * ranges to stop scraper abuse. So live Overpass fetching from the deployed
 * backend cannot be relied on. Instead: run this script from a machine with
 * working Overpass access (a laptop, not a datacenter) to pre-fetch places
 * for the app's fixed destination list, commit the result as a static JSON
 * file, and have the backend serve/seed its cache from that file. Re-run
 * this occasionally (e.g. every few months, or when new destinations are
 * added) to pick up OSM data changes — it's not meant to run automatically.
 *
 * Usage: node scripts/seed-places.js
 */
const fs = require("node:fs");
const path = require("node:path");
const { queryOverpassWithFallback, buildQuery, normalize } = require("../src/lib/overpass");

// Same coordinates as the app's src/data/destinationCoords.ts — duplicated
// here deliberately (small, stable list) rather than shared across repos.
const DESTINATIONS = {
  agra: { lat: 27.1767, lon: 78.0081 },
  jaipur: { lat: 26.9124, lon: 75.7873 },
  kerala: { lat: 9.4981, lon: 76.3388 },
  goa: { lat: 15.2993, lon: 74.124 },
  ladakh: { lat: 34.1526, lon: 77.5771 },
  varanasi: { lat: 25.3176, lon: 82.9739 },
  andaman: { lat: 11.6234, lon: 92.7265 },
  udaipur: { lat: 24.5854, lon: 73.7125 },
  rishikesh: { lat: 30.0869, lon: 78.2676 },
  darjeeling: { lat: 27.041, lon: 88.2663 },
  khajuraho: { lat: 24.8318, lon: 79.9199 },
  hampi: { lat: 15.335, lon: 76.46 },
  mysuru: { lat: 12.2958, lon: 76.6394 },
  coorg: { lat: 12.4244, lon: 75.7382 },
  gokarna: { lat: 14.5479, lon: 74.3188 },
  kabini: { lat: 11.928, lon: 76.3341 },
};

const DEFAULT_RADIUS_M = 10000;
const OUT_PATH = path.join(__dirname, "..", "src", "data", "placesSeed.json");

async function main() {
  const existing = fs.existsSync(OUT_PATH) ? JSON.parse(fs.readFileSync(OUT_PATH, "utf8")) : {};
  const seed = { ...existing };
  const force = process.argv.includes("--force");
  for (const [id, { lat, lon }] of Object.entries(DESTINATIONS)) {
    if (!force && existing[id]?.length) {
      console.log(`Skipping ${id} (already seeded, ${existing[id].length} places — pass --force to refetch)`);
      continue;
    }
    process.stdout.write(`Fetching ${id}... `);
    try {
      const data = await queryOverpassWithFallback(buildQuery(lat, lon, DEFAULT_RADIUS_M));
      const places = normalize(data.elements || [], lat, lon);
      seed[id] = places;
      console.log(`${places.length} places`);
    } catch (err) {
      console.log(`FAILED (${err.message}) — keeping any previous entry`);
      // seed[id] already holds the previous entry via the `{ ...existing }`
      // spread above — nothing to do here.
    }
    // Be polite to the shared free instances — small gap between requests.
    await new Promise((r) => setTimeout(r, 8000));
  }
  fs.writeFileSync(OUT_PATH, JSON.stringify(seed, null, 2));
  console.log(`\nWrote ${Object.keys(seed).length} destinations to ${OUT_PATH}`);
}

main();
