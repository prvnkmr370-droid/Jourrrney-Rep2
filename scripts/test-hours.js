/**
 * Checks GET /places/hours against a local stand-in for Google's Places API —
 * nothing leaves this machine and no key is needed:  node scripts/test-hours.js
 */
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const assert = require("node:assert/strict");

process.env.SQLITE_PATH = path.join(os.tmpdir(), `journey-hours-test-${process.pid}.sqlite`);

const seen = [];
let reply;
const google = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    seen.push({ headers: req.headers, body: JSON.parse(body || "{}") });
    res.writeHead(reply.status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(reply.json));
  });
});

const WEEK = [
  "Monday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM", "Tuesday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM",
  "Wednesday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM", "Thursday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM",
  "Friday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM", "Saturday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM",
  "Sunday: 6:00 AM – 1:00 PM, 5:00 PM – 9:00 PM",
];

async function main() {
  await new Promise((r) => google.listen(0, "127.0.0.1", r));
  process.env.GOOGLE_PLACES_API_URL = `http://127.0.0.1:${google.address().port}/v1/places:searchText`;
  const express = require("express");
  const app = express();
  app.use("/places", require("../src/routes/places"));
  const server = await new Promise((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  const get = async (qs) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/places/hours?${qs}`);
    return { status: r.status, json: await r.json() };
  };
  let n = 0;
  const ok = (m) => console.log(`ok ${++n} - ${m}`);

  delete process.env.GOOGLE_PLACES_API_KEY;
  let r = await get("name=Virupaksha%20Temple&state=Karnataka");
  assert.equal(r.status, 503);
  ok("no key configured -> 503 (the app falls back to curated hours)");

  process.env.GOOGLE_PLACES_API_KEY = "test-key";
  reply = { status: 200, json: { places: [{ id: "p1", displayName: { text: "Virupaksha Temple, Hampi" }, location: { latitude: 15.3351, longitude: 76.4600 }, regularOpeningHours: { weekdayDescriptions: WEEK } }] } };
  r = await get("name=Virupaksha%20Temple&state=Karnataka&lat=15.335&lon=76.46");
  assert.equal(r.status, 200);
  assert.equal(r.json.found, true);
  assert.equal(r.json.weekdayDescriptions.length, 7);
  assert.equal(r.json.source, "Google Maps");
  assert.equal(seen[0].headers["x-goog-api-key"], "test-key");
  assert.match(seen[0].headers["x-goog-fieldmask"], /regularOpeningHours/);
  assert.match(seen[0].body.textQuery, /Virupaksha Temple, Karnataka, India/);
  ok("matching place returns its 7 weekday lines; key and field mask sent");

  reply.json.places[0].displayName.text = "Hotel Sunrise";
  r = await get("name=Virupaksha%20Temple&state=Karnataka&lat=15.335&lon=76.46");
  assert.equal(r.json.found, false);
  ok("a different place is rejected, not shown");

  reply.json.places[0].displayName.text = "Virupaksha Temple";
  reply.json.places[0].location = { latitude: 28.6, longitude: 77.2 }; // Delhi
  r = await get("name=Virupaksha%20Temple&state=Karnataka&lat=15.335&lon=76.46");
  assert.equal(r.json.found, false);
  ok("same name but 1,700 km away is rejected");

  reply = { status: 200, json: { places: [{ id: "p2", displayName: { text: "Virupaksha Temple" } }] } };
  r = await get("name=Virupaksha%20Temple&state=Karnataka");
  assert.equal(r.json.found, false);
  ok("place without published hours -> found:false");

  reply = { status: 403, json: { error: { message: "API key not valid" } } };
  r = await get("name=Virupaksha%20Temple");
  assert.equal(r.status, 502);
  assert.ok(!JSON.stringify(r.json).includes("API key"));
  ok("Google error -> 502, detail not leaked to the app");

  r = await get("state=Karnataka");
  assert.equal(r.status, 400);
  ok("missing name -> 400");

  server.close(); google.close();
  console.log(`\nall ${n} checks passed`);
  process.exit(0);
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
