/**
 * AI-generated trip itinerary — POST /plan-trip/ai
 *
 * Calls an LLM to actually generate an itinerary, replacing what used to be
 * a purely rule-based template (still lives in the app as
 * generateItinerary() in src/screens/PlanTrip/data.ts, and stays there as
 * the final fallback when AI is unavailable entirely).
 *
 * Multi-provider, tried in order until one succeeds (see callAiJson /
 * buildProviderChain below): Gemini first (free, the established
 * default), then Groq, then Claude as the last resort — each skipped
 * automatically if its API key isn't set, so this works with just one
 * provider configured all the way up to all three. A single provider's
 * outage, "high demand" 503, or exhausted quota no longer takes AI
 * planning down by itself. Adding another provider later (e.g. xAI's
 * Grok) is one more entry in buildProviderChain — nothing else needs to
 * change.
 *
 * The app already has all the destination data (see journey-app's
 * destinations.ts) — rather than duplicating that database here, the
 * client sends the relevant destination context inline in the request
 * body, and this route just turns it into a well-shaped prompt and asks
 * for structured JSON back in the same shape the app already renders
 * (GeneratedDay[] from data.ts), so the result slots into the existing
 * ResultStep UI unchanged.
 *
 * POST /plan-trip/ai
 * body: {
 *   destination: { name, state, description, bestSeason, mustEat[], packingTips[], womenSafety: { score, level } },
 *   style: { label, transport, stay, local },   // from STYLE_CONFIGS
 *   days, people, preferences[], origin, startDate,
 *   dailyBudget: number                          // budgetBreakdown[tier].perDayPerPerson
 * }
 */
const express = require("express");
const { GoogleGenAI } = require("@google/genai");
const optionalAuth = require("../middleware/optionalAuth");
const { withGuidelines, recordMemory } = require("../lib/aiMemory");

const router = express.Router();

// Anthropic's Messages API — see ANTHROPIC_API_KEY in .env.example. Plain
// fetch, no SDK, same zero-new-dependency approach already used for Groq
// below (Node's built-in fetch is enough for both).
const CLAUDE_MODEL = "claude-sonnet-5-5";
const CLAUDE_ENDPOINT = "https://api.anthropic.com/v1/messages";
const CLAUDE_API_VERSION = "2023-06-01";

// gemini-2.5-flash was retired — Google's own API error on that model id
// points here. Verified working directly against the API before landing
// this (see commit message): returns clean JSON-mode output, same shape
// this route already expects.
const MODEL = "gemini-3.6-flash";

// Groq (console.groq.com — the fast-inference company, unrelated to xAI's
// "Grok") — text-only, since Groq's free tier doesn't have a vision model
// verified reliable enough for the photo-intent case (see supportsImage in
// buildProviderChain). All three providers are free-tier/no-billing-
// required to get started — see ANTHROPIC_API_KEY / GEMINI_API_KEY /
// GROQ_API_KEY in .env.example.
//
// NOTE: llama-3.3-70b-versatile (Groq's own quickstart-doc example model)
// is Enterprise-only as of this writing — console.groq.com/docs/models
// lists it "Contact Sales", no free-tier rate limits at all, and it 404s
// on a free-tier key. gpt-oss-120b is confirmed on the actual free tier
// (verified live against both the Models page and the Free Plan Limits
// table) — if this ever needs to change again, check that page directly
// rather than trusting the quickstart example.
const GROQ_MODEL = "openai/gpt-oss-120b";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Per-provider budget — up to 3 providers can run serially in the worst
// case (all fail), so this stays well under the app's own client-side
// timeouts (28-30s, see aiRequest.ts) even in that worst case.
const CLAUDE_TIMEOUT_MS = 9000;
const GEMINI_TIMEOUT_MS = 9000;
const GROQ_TIMEOUT_MS = 7000;

// Places the app already knows for this destination (its own highlights and
// nearby places), sent by the client as { name, type?, distance? }. Cleaned and
// capped here because they come from the request body and end up in a prompt.
const MAX_KNOWN_PLACES = 14;
function sanitizeKnownPlaces(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const p of raw) {
    const name = typeof p?.name === "string" ? p.name.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    if (!name) continue;
    const type = typeof p?.type === "string" ? p.type.replace(/\s+/g, " ").trim().slice(0, 50) : "";
    const distance = typeof p?.distance === "string" ? p.distance.replace(/\s+/g, " ").trim().slice(0, 40) : "";
    out.push({ name, type, distance });
    if (out.length >= MAX_KNOWN_PLACES) break;
  }
  return out;
}

// Stop names the model returned for one day: plain place names only, at most 4,
// trimmed and de-duplicated. Anything that is not a short string is dropped, so
// a malformed "stops" field can never break an otherwise good itinerary.
const MAX_STOPS_PER_DAY = 4;
function sanitizeStops(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.replace(/\s+/g, " ").trim() : "";
    if (!name || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
    if (out.length >= MAX_STOPS_PER_DAY) break;
  }
  return out;
}

function buildPrompt(body) {
  const { destination: d, style: sc, days, people, preferences, origin, startDate, dailyBudget } = body;
  const prefsList = preferences?.length ? preferences.join(", ") : "general sightseeing";
  const knownPlaces = sanitizeKnownPlaces(d.knownPlaces);
  const knownBlock = knownPlaces.length
    ? `\nPlaces our own ${d.name} guide already covers (use these exact names):\n${knownPlaces
        .map((p) => `- ${p.name}${p.type || p.distance ? ` (${[p.type, p.distance].filter(Boolean).join(", ")})` : ""}`)
        .join("\n")}\n`
    : "";
  return `You are a travel planner creating a ${days}-day itinerary for ${people} traveller(s) visiting ${d.name}, ${d.state}, India, travelling in the "${sc.label}" style (transport: ${sc.transport}; stay: ${sc.stay}; local travel: ${sc.local}).

Destination context: ${d.description}
Best season: ${d.bestSeason}
Traveller interests: ${prefsList}
Origin city: ${origin || "not specified"}
Start date: ${startDate || "flexible"}
Budget: roughly ₹${dailyBudget} per person per day.
Women's safety rating for this destination: ${d.womenSafety?.score}/10 (${d.womenSafety?.level}).
${knownBlock}
Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{
  "itinerary": [
    { "day": 1, "title": "short day title", "morning": "1-2 sentences", "afternoon": "1-2 sentences", "evening": "1-2 sentences", "stops": ["place name", "place name"], "estimatedCost": <number, INR for all travellers that day> }
  ],
  "tips": ["3-5 short, genuinely specific practical tips for this trip"]
}

Requirements:
- Exactly ${days} entries in "itinerary", days numbered 1 to ${days} in order.
- Ground every day in real, specific places/activities for ${d.name} — no generic filler like "explore the city".
- Reflect the "${sc.label}" style and the traveller's stated interests (${prefsList}) in what you suggest.
- estimatedCost figures should roughly total to about ₹${(dailyBudget * days * people).toLocaleString("en-IN")} across the whole trip, varying sensibly day to day.
- "stops" lists the 1-4 attractions or activities the day actually visits, as plain place names (no hotels, no restaurants, no travel legs). When a stop is one of the guide places above, write its name exactly as listed. You may add another place only if you are confident it really exists in or near ${d.name}; never invent one.
- Keep each field concise — this renders in a mobile app card, not a blog post.`;
}

// Claude sometimes wraps JSON in a markdown code fence even when told not
// to — defensive stripping before JSON.parse rather than trusting every
// provider to honor "no markdown fences" literally every time.
function stripJsonFences(text) {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

// Calls Claude's Messages API in text (or text+image) mode and parses the
// JSON out of its reply. `imagePart` is the same { base64, mimeType } shape
// the route handlers already use for Gemini's inlineData — undefined for
// every text-only route.
async function callClaudeJson(promptText, imagePart, timeoutMs) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Claude isn't configured on this server (no ANTHROPIC_API_KEY)."), { status: 503 });

  const content = imagePart
    ? [
        { type: "text", text: promptText },
        { type: "image", source: { type: "base64", media_type: imagePart.mimeType, data: imagePart.base64 } },
      ]
    : promptText;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(CLAUDE_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": CLAUDE_API_VERSION },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 2048, temperature: 0.6, messages: [{ role: "user", content }] }),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(`Claude request failed (${res.status})`), { status: 502, detail });
    }
    const data = await res.json();
    const text = data?.content?.find((block) => block.type === "text")?.text;
    if (!text) throw new Error("Empty response from Claude");
    try {
      return JSON.parse(stripJsonFences(text));
    } catch {
      throw new Error("Claude returned non-JSON output");
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Calls Gemini in JSON mode and parses the result. `contents` is either a
// plain prompt string or a Part[] (text + inlineData) for image requests —
// the SDK accepts both under the same `contents` field.
async function callGeminiJson(contents, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Gemini isn't configured on this server (no GEMINI_API_KEY)."), { status: 503 });

  const ai = new GoogleGenAI({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: { responseMimeType: "application/json", temperature: 0.6 },
    });
    clearTimeout(timeout);
    const text = response.text;
    if (!text) throw new Error("Empty response from Gemini");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Gemini returned non-JSON output");
    }
  } finally {
    clearTimeout(timeout);
  }
}

// Same job as the two above, against Groq's OpenAI-compatible
// chat-completions endpoint (plain fetch — Groq needs no SDK). Text-only —
// see supportsImage: false in buildProviderChain below.
async function callGroqJson(promptText) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw Object.assign(new Error("Groq isn't configured on this server (no GROQ_API_KEY)."), { status: 503 });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), GROQ_TIMEOUT_MS);
  try {
    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: promptText }],
        temperature: 0.6,
        response_format: { type: "json_object" },
      }),
    });
    clearTimeout(timeout);
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw Object.assign(new Error(`Groq request failed (${res.status})`), { status: 502, detail });
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (!text) throw new Error("Empty response from Groq");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("Groq returned non-JSON output");
    }
  } finally {
    clearTimeout(timeout);
  }
}

// The provider chain itself — tried in this order until one succeeds.
// Gemini stays primary (free, already the established default); Groq and
// then Claude are the fallbacks for when Gemini's free-tier limit is hit
// (a "high demand" 503, a timeout, or its daily quota) — Groq before
// Claude since Groq is also free/no-card, so no billing is touched unless
// both free options have failed too. A provider is skipped entirely if its
// key isn't configured, or if this request carries an image and the
// provider doesn't support vision (Groq doesn't — see supportsImage).
// To add a new provider later (e.g. xAI's Grok — note: NOT the same as
// Groq above, see the GROQ_MODEL comment), write its own callXJson() the
// same shape as the three below and add one entry here; nothing else in
// this file needs to change.
function buildProviderChain(promptText, imagePart) {
  return [
    {
      name: "gemini",
      configured: !!process.env.GEMINI_API_KEY,
      supportsImage: true,
      call: (timeoutMs) =>
        callGeminiJson(imagePart ? [{ text: promptText }, { inlineData: { data: imagePart.base64, mimeType: imagePart.mimeType } }] : promptText, timeoutMs),
    },
    { name: "groq", configured: !!process.env.GROQ_API_KEY, supportsImage: false, call: () => callGroqJson(promptText) },
    { name: "claude", configured: !!process.env.ANTHROPIC_API_KEY, supportsImage: true, call: (timeoutMs) => callClaudeJson(promptText, imagePart, timeoutMs) },
  ];
}

const PROVIDER_TIMEOUT_MS = { claude: CLAUDE_TIMEOUT_MS, gemini: GEMINI_TIMEOUT_MS, groq: GROQ_TIMEOUT_MS };

/**
 * Tries each configured, image-capable (when needed) provider in order
 * until one returns usable JSON. `imagePart` (optional, { base64,
 * mimeType }) is the one thing every provider's call needs in the same
 * shape — callers never build a provider-specific request themselves.
 * Returns `{ result, source, attempted }` — `source` is whichever provider
 * actually answered, `attempted` lists every provider tried before that
 * (empty on a first-try success) so logs/responses show exactly what was
 * tried, not just pass/fail. Throws the LAST provider's error (augmented
 * with `.attempted`) only if every configured provider failed.
 */
async function callAiJson(promptText, imagePart) {
  const chain = buildProviderChain(promptText, imagePart).filter((p) => p.configured && (!imagePart || p.supportsImage));
  if (chain.length === 0) {
    throw Object.assign(new Error("AI isn't configured on this server (set ANTHROPIC_API_KEY, GEMINI_API_KEY, or GROQ_API_KEY)."), { status: 503, attempted: [] });
  }

  const attempted = [];
  let lastErr;
  for (const provider of chain) {
    try {
      const result = await provider.call(PROVIDER_TIMEOUT_MS[provider.name]);
      return { result, source: provider.name, attempted };
    } catch (err) {
      console.error(`${provider.name} call failed:`, err.message);
      attempted.push({ provider: provider.name, error: err.message });
      lastErr = err;
    }
  }
  throw Object.assign(lastErr, { attempted });
}

// GET /plan-trip/status — booleans only, never the actual key values. Lets
// us (and you) confirm a just-added API key actually made it into the live
// environment after a redeploy, without needing to force a failure or
// expose any secret over the wire.
router.get("/status", (_req, res) => {
  res.json({
    claude: { configured: !!process.env.ANTHROPIC_API_KEY, model: CLAUDE_MODEL },
    gemini: { configured: !!process.env.GEMINI_API_KEY, model: MODEL },
    groq: { configured: !!process.env.GROQ_API_KEY, model: GROQ_MODEL },
  });
});

router.post("/ai", optionalAuth, async (req, res) => {
  const { destination, style, days, people } = req.body || {};
  if (!destination?.name || !style?.label || !days || !people) {
    return res.status(400).json({ error: "destination, style, days, and people are required" });
  }

  try {
    const prompt = withGuidelines(buildPrompt(req.body), req.userId);
    const { result: parsed, source } = await callAiJson(prompt);
    if (!Array.isArray(parsed.itinerary) || parsed.itinerary.length === 0) {
      throw new Error(`Malformed itinerary in ${source} response`);
    }
    // Remember (signed-in users only) what was asked, so later answers can reflect it.
    recordMemory(
      req.userId,
      "plan",
      `Planned a ${days}-day ${style.label} trip to ${destination.name}, ${destination.state} for ${people} traveller(s)` +
        (req.body.origin ? ` from ${req.body.origin}` : "") +
        (Array.isArray(req.body.preferences) && req.body.preferences.length ? `; interests: ${req.body.preferences.join(", ")}` : "") +
        (req.body.dailyBudget ? `; budget about ₹${req.body.dailyBudget} per person per day` : "")
    );
    const itinerary = parsed.itinerary.map((day) => ({ ...day, stops: sanitizeStops(day?.stops) }));
    return res.json({ itinerary, tips: Array.isArray(parsed.tips) ? parsed.tips : [], source });
  } catch (err) {
    console.error("AI trip-plan generation failed (all providers):", err.message, JSON.stringify(err.attempted ?? []));
    // 502 tells the app this specific call failed (not a client mistake) —
    // it falls back to the local rule-based generator, so an outage across
    // every configured provider never actually blocks trip planning.
    return res.status(err.status ?? 502).json({
      error: "AI planning is temporarily unavailable — using the standard planner instead.",
      detail: err.message,
      attempted: err.attempted ?? [],
    });
  }
});

/**
 * POST /plan-trip/route-info — a complete door-to-door route from an
 * arbitrary origin city to a destination, for each realistic mode.
 * Generalizes what used to be hardcoded Delhi/Mumbai/Bangalore-only
 * `Transport.fromDelhi` etc. strings in the app's destinations.ts — the
 * app has no coordinate data for most of its ~1,787 destinations and no
 * airport/station dataset, so rather than building either out, this asks
 * Gemini/Groq for an approximate distance + a full per-mode journey
 * (departure waypoint near the origin → arrival waypoint near the
 * destination → last-mile leg to the actual destination) directly, same
 * spirit as the app's existing hand-written transport text ("~1h direct",
 * "₹2,500–₹9,000" — approximate, not survey-precise). This closes the loop
 * that a bare "nearest airport to the origin" left open: the user also
 * needs to know which airport/station to land at near the destination and
 * how to cover that last stretch (taxi/bus/auto) to actually get there.
 *
 * body: { origin: string, destination: { name: string, state: string } }
 */
function buildRouteInfoPrompt(origin, destination) {
  return `A traveller is starting their trip from ${origin}, India, and wants to reach ${destination.name}, ${destination.state}, India.

Give a realistic, practical, COMPLETE door-to-door travel breakdown for this specific route — for each mode, the full chain from ${origin} all the way to ${destination.name}, not just one leg of it.

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{
  "distanceKm": <number, approximate straight-line/travel distance in km from ${origin} to ${destination.name}>,
  "transport": [
    {
      "mode": "Flight",
      "duration": "<total door-to-door estimate, ${origin} to ${destination.name}>",
      "costRange": "<INR flight-fare range, per person one-way>",
      "departurePoint": { "name": "<airport with scheduled flights nearest to ${origin}>", "code": "<3-letter IATA code>", "distanceFromOrigin": "<short string, e.g. '~12 km / 30 min by taxi'>" },
      "arrivalPoint": { "name": "<airport nearest to ${destination.name} that this flight would land at>", "code": "<3-letter IATA code>", "distanceFromDestination": "<short string, e.g. '~15 km / 30 min'>" },
      "lastMileOptions": [
        { "mode": "Taxi/App cab", "duration": "<time from that airport to ${destination.name}>", "costRange": "<INR range>", "details": "<1 short sentence>" },
        { "mode": "Airport bus/shuttle", "duration": "...", "costRange": "...", "details": "<1 short sentence — omit this option entirely if no such service realistically exists for this airport>" },
        { "mode": "Auto-rickshaw", "duration": "...", "costRange": "...", "details": "<1 short sentence — omit if impractical for the distance involved>" }
      ],
      "details": "<1 short sentence on the flight leg itself — airline/stops/connections if relevant>",
      "tips": "<1 short practical tip>"
    },
    {
      "mode": "Train",
      "duration": "...", "costRange": "...",
      "departurePoint": { "name": "<railway station nearest to ${origin}>", "code": "<station code if well-known, else null>", "distanceFromOrigin": "..." },
      "arrivalPoint": { "name": "<railway station nearest to ${destination.name}>", "code": "...", "distanceFromDestination": "..." },
      "lastMileOptions": [
        { "mode": "...", "duration": "...", "costRange": "...", "details": "..." }
      ],
      "details": "<which train(s)/route>", "tips": "..."
    },
    {
      "mode": "Bus",
      "duration": "...", "costRange": "...",
      "departurePoint": { "name": "<main government/inter-state bus terminus (ISBT or state transport corporation stand) nearest to ${origin}>", "code": null, "distanceFromOrigin": "..." },
      "arrivalPoint": { "name": "<main bus terminus nearest to ${destination.name}>", "code": null, "distanceFromDestination": "..." },
      "lastMileOptions": [
        { "mode": "...", "duration": "...", "costRange": "...", "details": "..." }
      ],
      "details": "<which state transport corporation(s)/operators run this route, e.g. volvo/sleeper/ordinary>", "tips": "..."
    },
    {
      "mode": "Road",
      "duration": "...", "costRange": "...",
      "departurePoint": null, "arrivalPoint": null, "lastMileOptions": [],
      "details": "<self-drive or private cab: the actual driving route — major highways/towns passed through>", "tips": "..."
    }
  ]
}

Requirements:
- Only include a "transport" entry for a mode that's actually realistic for this route (e.g. omit "Train" if no sensible rail route exists, omit "Bus" if the distance is too long for a reasonable intercity bus journey); keep at least one entry.
- "departurePoint"/"arrivalPoint" are null for "Road" (no transfer point — it's a direct self-drive/cab route) and required for "Flight"/"Train"/"Bus" when that mode is included.
- "Bus" is specifically government/inter-state bus travel via a real bus terminus — distinct from "Road" (self-drive/private cab, no terminus). Don't merge the two.
- "lastMileOptions" must cover how to travel the ACTUAL remaining distance from "arrivalPoint" to ${destination.name}, as a SHORT LIST of realistic alternatives (e.g. taxi/app cab, airport or railway/bus-stand shuttle, auto-rickshaw, local train/metro/local bus where relevant) so the traveller can pick one — not just a single mode. Give 1-3 options per Flight/Train/Bus entry depending on what's genuinely available at that arrival point and distance; never invent a bus/shuttle service that doesn't plausibly exist. Empty array only for Road, or for Flight/Train/Bus if the arrival point IS ${destination.name} itself (e.g. the terminus is effectively in the destination town).
- Costs and durations are per-person, one-way, approximate — ranges are fine.
- Keep every field concise — this renders in a mobile app card, not a blog post.`;
}

function sanitizeWaypoint(w, distanceKey) {
  if (!w || typeof w.name !== "string") return null;
  return {
    name: w.name,
    code: typeof w.code === "string" ? w.code : null,
    [distanceKey]: typeof w[distanceKey] === "string" ? w[distanceKey] : "",
  };
}

function sanitizeLastMileOptions(options) {
  if (!Array.isArray(options)) return [];
  return options
    .filter((lm) => lm && typeof lm.mode === "string")
    .map((lm) => ({
      mode: lm.mode,
      duration: typeof lm.duration === "string" ? lm.duration : "",
      costRange: typeof lm.costRange === "string" ? lm.costRange : "",
      details: typeof lm.details === "string" ? lm.details : "",
    }));
}

router.post("/route-info", optionalAuth, async (req, res) => {
  const { origin, destination } = req.body || {};
  if (typeof origin !== "string" || !origin.trim() || !destination?.name || !destination?.state) {
    return res.status(400).json({ error: "origin and destination.name/state are required" });
  }

  try {
    const prompt = withGuidelines(buildRouteInfoPrompt(origin.trim(), destination), req.userId);
    const { result: parsed, source } = await callAiJson(prompt);
    if (typeof parsed.distanceKm !== "number" || !(parsed.distanceKm > 0) || !Array.isArray(parsed.transport) || parsed.transport.length === 0) {
      throw new Error(`Malformed route-info in ${source} response`);
    }
    recordMemory(req.userId, "route", `Looked up how to reach ${destination.name}, ${destination.state} from ${origin.trim()}`);
    return res.json({
      distanceKm: parsed.distanceKm,
      transport: parsed.transport
        .filter((t) => t && typeof t.mode === "string")
        .map((t) => ({
          mode: t.mode,
          duration: typeof t.duration === "string" ? t.duration : "",
          costRange: typeof t.costRange === "string" ? t.costRange : "",
          details: typeof t.details === "string" ? t.details : "",
          tips: typeof t.tips === "string" ? t.tips : "",
          departurePoint: sanitizeWaypoint(t.departurePoint, "distanceFromOrigin"),
          arrivalPoint: sanitizeWaypoint(t.arrivalPoint, "distanceFromDestination"),
          lastMileOptions: sanitizeLastMileOptions(t.lastMileOptions),
        })),
      source,
    });
  } catch (err) {
    console.error("AI route-info generation failed (all providers):", err.message, JSON.stringify(err.attempted ?? []));
    return res.status(err.status ?? 502).json({
      error: "Couldn't fetch route details right now.",
      detail: err.message,
      attempted: err.attempted ?? [],
    });
  }
});

/**
 * POST /plan-trip/parse-intent — free-text (and now optionally photo-
 * based) trip-intent understanding, inspired by two things Layla.ai does:
 * handling fuzzy requests ("a warm place in February that's not too
 * expensive from Paris") rather than requiring an exact destination name,
 * and reading a photo for inspiration. The app's own fast local matcher
 * (see matchDestination.ts / parseTripMessage.ts) handles the plain-name
 * case — this route is the fallback for everything that isn't, so a vague
 * message or an inspiration photo still has a real shot at landing on one
 * of the app's actual destinations instead of a dead end.
 *
 * Grounded, not generative: Gemini is only allowed to pick a
 * destinationId from the exact list the client sends (this app's own
 * database) — it never invents a place, and is explicitly told to return
 * null rather than force-fit an unrelated one when nothing genuinely
 * matches the request or the photo.
 *
 * A null destinationId is deliberately NOT treated as "this place is
 * outside India" — the list is only this app's current catalog, not every
 * real place in the country, so most real Indian towns/villages/forts
 * simply aren't in it yet. The response carries a separate `outsideIndia`
 * boolean (see buildIntentPrompt) so the client can tell "real Indian
 * place we don't have data for" apart from "genuinely a different
 * country" and respond honestly instead of assuming the latter.
 *
 * body: {
 *   message?: string,
 *   image?: { base64: string, mimeType: string },   // at least one of message/image required
 *   destinations: { id, name, state, tagline, category }[]
 * }
 */
const MAX_IMAGE_BASE64_CHARS = 6_000_000; // ~4.5MB decoded — plenty for a resized phone photo, well under the 8mb body-limit ceiling in index.js

function buildIntentPrompt(message, hasImage, destinations) {
  const list = destinations.map((d) => `${d.id} | ${d.name}, ${d.state} | ${d.tagline} | ${(d.category || []).join("/")}`).join("\n");
  const requestDescription = hasImage
    ? message
      ? `A user attached a photo to a travel-planning chat, with this caption: "${message}"`
      : `A user attached a photo to a travel-planning chat, with no caption.`
    : `A user typed this trip request into a travel-planning chat: "${message}"`;

  return `${requestDescription}

Here is the ONLY list of destinations available to plan a trip to (id | name, state | tagline | categories):
${list}

Task: interpret the request${hasImage ? " — including what's actually shown in the photo (scenery, architecture, activity, mood) as the primary signal, using any caption as extra context" : ", however vague or indirect (\"somewhere warm and cheap in February\", \"a beach trip not too far from Bangalore\")"}, and pick the single best-matching destination id from the list above — using the tagline/categories to judge vibe/theme, not just literal name matches.

This list is NOT the full set of real places in India — it's just this one app's current catalog, which is still growing. So when nothing in the list is a good fit, use your own real-world/geographic knowledge (not just the list) to classify why into exactly ONE of these three cases, and set the matching fields:
1. Genuinely outside India — the request${hasImage ? "/photo" : ""} clearly names or strongly implies a real, specific place outside India (e.g. an international destination like Bali or Paris, or a photo that's obviously not India — a foreign skyline, a non-Indian script on a sign, etc.). Set "outsideIndia": true, "recognizedIndianPlace": false.
2. A real Indian place you recognize, just not in this app's list — the request names a specific, real place (a town, village, fort, temple, trek, region, etc.) that you know is in India, but it genuinely isn't one of the entries above. This is the MOST COMMON case when destinationId is null — most real Indian places are simply not in this list yet, and that is expected, not a sign the place is foreign. Set "outsideIndia": false, "recognizedIndianPlace": true, and put the actual place name you recognized in "recognizedPlaceName" (e.g. "Hampi" or "Spiti Valley") — do NOT set outsideIndia true just because it's missing from the list.
3. Nothing specific enough to place at all — the request is too vague, generic, or unrelated to name any real place, in India or otherwise (e.g. "somewhere fun", "help me plan something"). Set "outsideIndia": false, "recognizedIndianPlace": false.

Only return a non-null destinationId when the list above genuinely contains a reasonable match; otherwise return null and classify per the three cases above rather than forcing a bad match.

Also pull out, only if explicitly stated or very strongly implied:
- a number of days
- a number of travellers
- a travel style: "backpacker" (budget/backpacking), "comfortable" (mid-range/comfortable), or "premium" (luxury/premium) — only if the request clearly signals one
- interests, from this fixed set only: heritage, nature, food, adventure, wellness, photography, offbeat, shopping

Return ONLY a JSON object, no markdown fences, no commentary:
{
  "destinationId": "<id from the list above, or null>",
  "outsideIndia": <true or false — see case 1 above; only meaningful when destinationId is null>,
  "recognizedIndianPlace": <true or false — see case 2 above; only meaningful when destinationId is null>,
  "recognizedPlaceName": "<the real place name you recognized, if recognizedIndianPlace is true; otherwise null>",
  "days": <number or null>,
  "people": <number or null>,
  "style": "<backpacker|comfortable|premium|null>",
  "interests": [<zero or more of the fixed set above>],
  "reasoning": "<one short sentence, shown to the user, explaining the match${hasImage ? " (mention what you recognized in the photo)" : ""}, or — if destinationId is null — plainly saying which of the three cases above applies and why>"
}`;
}

router.post("/parse-intent", optionalAuth, async (req, res) => {
  const { message, image, destinations } = req.body || {};
  const hasMessage = typeof message === "string" && message.trim().length > 0;
  const hasImage = !!(image && typeof image.base64 === "string" && typeof image.mimeType === "string");

  if ((!hasMessage && !hasImage) || !Array.isArray(destinations) || destinations.length === 0) {
    return res.status(400).json({ error: "message and/or image, plus a non-empty destinations array, are required" });
  }
  if (hasImage && image.base64.length > MAX_IMAGE_BASE64_CHARS) {
    return res.status(413).json({ error: "That photo is too large — try a smaller one." });
  }
  if (hasImage && !image.mimeType.startsWith("image/")) {
    return res.status(400).json({ error: "image.mimeType must be an image/* type" });
  }

  const prompt = withGuidelines(buildIntentPrompt(hasMessage ? message.trim() : "", hasImage, destinations), req.userId);
  // Groq has no vision model in its free tier — a photo request only tries
  // Claude/Gemini (both vision-capable), handled automatically by
  // buildProviderChain's supportsImage filter once imagePart is passed.
  const imagePart = hasImage ? { base64: image.base64, mimeType: image.mimeType } : undefined;

  try {
    const { result: parsed, source } = await callAiJson(prompt, imagePart);
    const validIds = new Set(destinations.map((d) => d.id));
    const destinationId = typeof parsed.destinationId === "string" && validIds.has(parsed.destinationId) ? parsed.destinationId : null;
    // Photos are never stored; only the typed text is remembered (signed-in users only).
    if (hasMessage) recordMemory(req.userId, "question", message.trim());
    return res.json({
      destinationId,
      // Both only meaningful when destinationId is null — see
      // buildIntentPrompt's three-way rule for why "not in our list",
      // "recognized as real but not in our list", and "genuinely not in
      // India" must never collapse into the same client-side message.
      // Both default false (i.e. "don't assume anything") if Gemini/Groq
      // omitted or malformed the field.
      outsideIndia: destinationId === null && parsed.outsideIndia === true,
      recognizedIndianPlace: destinationId === null && parsed.outsideIndia !== true && parsed.recognizedIndianPlace === true,
      recognizedPlaceName: destinationId === null && typeof parsed.recognizedPlaceName === "string" ? parsed.recognizedPlaceName : null,
      days: Number.isInteger(parsed.days) && parsed.days > 0 && parsed.days <= 30 ? parsed.days : null,
      people: Number.isInteger(parsed.people) && parsed.people > 0 && parsed.people <= 20 ? parsed.people : null,
      style: ["backpacker", "comfortable", "premium"].includes(parsed.style) ? parsed.style : null,
      interests: Array.isArray(parsed.interests) ? parsed.interests.filter((i) => typeof i === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      source,
    });
  } catch (err) {
    console.error("AI intent-parsing failed (all providers):", err.message, JSON.stringify(err.attempted ?? []));
    return res.status(err.status ?? 502).json({
      error: "Couldn't interpret that right now.",
      detail: err.message,
      attempted: err.attempted ?? [],
    });
  }
});

module.exports = router;
