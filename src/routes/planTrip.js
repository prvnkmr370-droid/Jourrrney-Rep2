/**
 * AI-generated trip itinerary — POST /plan-trip/ai
 *
 * Uses Google's Gemini API (free tier — see .env.example for how to get a
 * key) to actually generate an itinerary, replacing what used to be a
 * purely rule-based template (still lives in the app as generateItinerary()
 * in src/screens/PlanTrip/data.ts, and stays there as the final fallback
 * when AI is unavailable entirely). Gemini also has its own failsafe now:
 * on a Gemini failure, the same request is retried once against Groq's
 * free tier (see callAiJson below) before giving up to the local planner —
 * both free, no billing on either, so a single provider's "high demand"
 * 503 or an exhausted quota doesn't take AI planning down by itself.
 *
 * The app already has all the destination data (see journey-app's
 * destinations.ts) — rather than duplicating that database here, the
 * client sends the relevant destination context inline in the request
 * body, and this route just turns it into a well-shaped prompt and asks
 * Gemini for structured JSON back in the same shape the app already
 * renders (GeneratedDay[] from data.ts), so the result slots into the
 * existing ResultStep UI unchanged.
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

const router = express.Router();

// gemini-2.5-flash was retired — Google's own API error on that model id
// points here. Verified working directly against the API before landing
// this (see commit message): returns clean JSON-mode output, same shape
// this route already expects.
const MODEL = "gemini-3.6-flash";

// Groq (console.groq.com — the fast-inference company, unrelated to xAI's
// "Grok") is the failsafe: on a Gemini failure (the free tier's occasional
// "high demand" 503, a timeout, a quota blip), the SAME prompt is retried
// here instead of giving up straight to the local rule-based fallback.
// Text-only — Groq's free tier doesn't have a vision model verified
// reliable enough for the photo-intent case, so image requests stay
// Gemini-only (see hasFallback below). Both free tiers, no billing on
// either — see GEMINI_API_KEY / GROQ_API_KEY in .env.example.
const GROQ_MODEL = "llama-3.3-70b-versatile";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";

// Shorter Gemini timeout when a Groq fallback is available (text-only
// requests) — no point waiting the full budget on the primary when a
// working secondary is one quick call away. The image path has no
// fallback, so it keeps the old, longer budget.
const GEMINI_TIMEOUT_MS_WITH_FALLBACK = 12000;
const GEMINI_TIMEOUT_MS_NO_FALLBACK = 20000;
const GROQ_TIMEOUT_MS = 10000;

function buildPrompt(body) {
  const { destination: d, style: sc, days, people, preferences, origin, startDate, dailyBudget } = body;
  const prefsList = preferences?.length ? preferences.join(", ") : "general sightseeing";
  return `You are a travel planner creating a ${days}-day itinerary for ${people} traveller(s) visiting ${d.name}, ${d.state}, India, travelling in the "${sc.label}" style (transport: ${sc.transport}; stay: ${sc.stay}; local travel: ${sc.local}).

Destination context: ${d.description}
Best season: ${d.bestSeason}
Traveller interests: ${prefsList}
Origin city: ${origin || "not specified"}
Start date: ${startDate || "flexible"}
Budget: roughly ₹${dailyBudget} per person per day.
Women's safety rating for this destination: ${d.womenSafety?.score}/10 (${d.womenSafety?.level}).

Return ONLY a JSON object (no markdown fences, no commentary) with this exact shape:
{
  "itinerary": [
    { "day": 1, "title": "short day title", "morning": "1-2 sentences", "afternoon": "1-2 sentences", "evening": "1-2 sentences", "estimatedCost": <number, INR for all travellers that day> }
  ],
  "tips": ["3-5 short, genuinely specific practical tips for this trip"]
}

Requirements:
- Exactly ${days} entries in "itinerary", days numbered 1 to ${days} in order.
- Ground every day in real, specific places/activities for ${d.name} — no generic filler like "explore the city".
- Reflect the "${sc.label}" style and the traveller's stated interests (${prefsList}) in what you suggest.
- estimatedCost figures should roughly total to about ₹${(dailyBudget * days * people).toLocaleString("en-IN")} across the whole trip, varying sensibly day to day.
- Keep each field concise — this renders in a mobile app card, not a blog post.`;
}

// Shared by all routes below: calls Gemini in JSON mode, parses the
// result, and throws a plain Error with a useful message on any failure
// (no API key, timeout, non-JSON output) — callers turn that into the
// appropriate HTTP response themselves. `contents` is either a plain
// prompt string or a Part[] (text + inlineData) for the image-intent
// route below — the SDK accepts both under the same `contents` field.
async function callGeminiJson(contents, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("AI isn't configured on this server yet (no GEMINI_API_KEY)."), { status: 503 });

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

// The failsafe: same job as callGeminiJson but against Groq's OpenAI-
// compatible chat-completions endpoint (plain fetch — Groq needs no SDK,
// keeping this a zero-new-dependency change). Text-only, since the
// image/vision route never calls this (see hasFallback in each route).
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

/**
 * Gemini-first, Groq-as-failsafe. `promptText` must be the same request
 * expressed as a plain string — Groq only takes text, so the image-intent
 * route passes `hasFallback: false` and this collapses to "just call
 * Gemini" for that case, unchanged from before. Whichever provider
 * actually answers is returned as `source` so callers/clients can tell
 * (and so it's visible in logs which free tier is carrying a given
 * request, useful for noticing if one side is rate-limited a lot).
 */
async function callAiJson(geminiContents, promptText, hasFallback) {
  try {
    const result = await callGeminiJson(geminiContents, hasFallback ? GEMINI_TIMEOUT_MS_WITH_FALLBACK : GEMINI_TIMEOUT_MS_NO_FALLBACK);
    return { result, source: "gemini" };
  } catch (geminiErr) {
    if (!hasFallback) throw geminiErr;
    console.error("Gemini call failed, falling back to Groq:", geminiErr.message);
    try {
      const result = await callGroqJson(promptText);
      return { result, source: "groq" };
    } catch (groqErr) {
      console.error("Groq fallback also failed:", groqErr.message);
      // Surface the ORIGINAL Gemini error to the client (its status code is
      // the more meaningful one — e.g. "no API key" vs Groq's own outage) —
      // both having failed just means the caller falls through to the
      // existing local rule-based planner, same contract as before. Attach
      // the fallback attempt's own outcome too (non-secret — just error
      // text) so it's visible in the response/logs rather than silently
      // swallowed, which made a real Gemini+Groq double-failure look
      // identical to "Groq was never tried" from the outside.
      throw Object.assign(geminiErr, { groqAttempted: true, groqError: groqErr.message });
    }
  }
}

// GET /plan-trip/status — booleans only, never the actual key values.
// Lets us (and you) confirm a just-added GROQ_API_KEY actually made it
// into the live environment after a Render redeploy, without needing to
// force a Gemini failure or expose any secret over the wire.
router.get("/status", (_req, res) => {
  res.json({
    gemini: { configured: !!process.env.GEMINI_API_KEY, model: MODEL },
    groq: { configured: !!process.env.GROQ_API_KEY, model: GROQ_MODEL },
  });
});

router.post("/ai", async (req, res) => {
  const { destination, style, days, people } = req.body || {};
  if (!destination?.name || !style?.label || !days || !people) {
    return res.status(400).json({ error: "destination, style, days, and people are required" });
  }

  try {
    const prompt = buildPrompt(req.body);
    // Always text-only here (no photo in this route) — the Groq failsafe
    // always applies.
    const { result: parsed, source } = await callAiJson(prompt, prompt, true);
    if (!Array.isArray(parsed.itinerary) || parsed.itinerary.length === 0) {
      throw new Error(`Malformed itinerary in ${source} response`);
    }
    return res.json({ itinerary: parsed.itinerary, tips: Array.isArray(parsed.tips) ? parsed.tips : [], source });
  } catch (err) {
    console.error("AI trip-plan generation failed (both Gemini and Groq):", err.message, err.groqAttempted ? `| groq: ${err.groqError}` : "| groq: not attempted");
    // 502 tells the app this specific call failed (not a client mistake) —
    // it falls back to the local rule-based generator, so an outage on
    // both free tiers never actually blocks trip planning.
    return res.status(err.status ?? 502).json({
      error: "AI planning is temporarily unavailable — using the standard planner instead.",
      detail: err.message,
      groqAttempted: !!err.groqAttempted,
      groqError: err.groqError ?? null,
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

Task: interpret the request${hasImage ? " — including what's actually shown in the photo (scenery, architecture, activity, mood) as the primary signal, using any caption as extra context" : ", however vague or indirect (\"somewhere warm and cheap in February\", \"a beach trip not too far from Bangalore\")"}, and pick the single best-matching destination id from the list above — using the tagline/categories to judge vibe/theme, not just literal name matches. If the request${hasImage ? "/photo" : ""} clearly names or implies a place genuinely outside this list (e.g. an international destination like Bali or Paris, or a photo that's obviously not India), or nothing in the list is a reasonable fit at all, return null for destinationId rather than forcing a bad match.

Also pull out, only if explicitly stated or very strongly implied:
- a number of days
- a number of travellers
- a travel style: "backpacker" (budget/backpacking), "comfortable" (mid-range/comfortable), or "premium" (luxury/premium) — only if the request clearly signals one
- interests, from this fixed set only: heritage, nature, food, adventure, wellness, photography, offbeat, shopping

Return ONLY a JSON object, no markdown fences, no commentary:
{
  "destinationId": "<id from the list above, or null>",
  "days": <number or null>,
  "people": <number or null>,
  "style": "<backpacker|comfortable|premium|null>",
  "interests": [<zero or more of the fixed set above>],
  "reasoning": "<one short sentence, shown to the user, explaining the match${hasImage ? " (mention what you recognized in the photo)" : ""} (or why nothing matched)>"
}`;
}

router.post("/parse-intent", async (req, res) => {
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

  const prompt = buildIntentPrompt(hasMessage ? message.trim() : "", hasImage, destinations);
  const contents = hasImage ? [{ text: prompt }, { inlineData: { data: image.base64, mimeType: image.mimeType } }] : prompt;
  // The Groq failsafe only understands plain text — a photo request stays
  // Gemini-only, same as before this change.
  const hasFallback = !hasImage;

  try {
    const { result: parsed, source } = await callAiJson(contents, prompt, hasFallback);
    const validIds = new Set(destinations.map((d) => d.id));
    const destinationId = typeof parsed.destinationId === "string" && validIds.has(parsed.destinationId) ? parsed.destinationId : null;
    return res.json({
      destinationId,
      days: Number.isInteger(parsed.days) && parsed.days > 0 && parsed.days <= 30 ? parsed.days : null,
      people: Number.isInteger(parsed.people) && parsed.people > 0 && parsed.people <= 20 ? parsed.people : null,
      style: ["backpacker", "comfortable", "premium"].includes(parsed.style) ? parsed.style : null,
      interests: Array.isArray(parsed.interests) ? parsed.interests.filter((i) => typeof i === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
      source,
    });
  } catch (err) {
    console.error("AI intent-parsing failed (both Gemini and Groq):", err.message, err.groqAttempted ? `| groq: ${err.groqError}` : "| groq: not attempted");
    return res.status(err.status ?? 502).json({
      error: "Couldn't interpret that right now.",
      detail: err.message,
      groqAttempted: !!err.groqAttempted,
      groqError: err.groqError ?? null,
    });
  }
});

module.exports = router;
