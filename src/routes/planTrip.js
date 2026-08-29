/**
 * AI-generated trip itinerary — POST /plan-trip/ai
 *
 * Uses Google's Gemini API (free tier — see .env.example for how to get a
 * key) to actually generate an itinerary, replacing what used to be a
 * purely rule-based template (still lives in the app as generateItinerary()
 * in src/screens/PlanTrip/data.ts, and stays there as the fallback when
 * this endpoint is unavailable — no API key configured, Gemini's free-tier
 * quota exhausted, network hiccup, etc.).
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
const REQUEST_TIMEOUT_MS = 20000;

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
async function callGeminiJson(contents) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw Object.assign(new Error("AI isn't configured on this server yet (no GEMINI_API_KEY)."), { status: 503 });

  const ai = new GoogleGenAI({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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

router.post("/ai", async (req, res) => {
  const { destination, style, days, people } = req.body || {};
  if (!destination?.name || !style?.label || !days || !people) {
    return res.status(400).json({ error: "destination, style, days, and people are required" });
  }

  try {
    const parsed = await callGeminiJson(buildPrompt(req.body));
    if (!Array.isArray(parsed.itinerary) || parsed.itinerary.length === 0) {
      throw new Error("Malformed itinerary in Gemini response");
    }
    return res.json({ itinerary: parsed.itinerary, tips: Array.isArray(parsed.tips) ? parsed.tips : [], source: "gemini" });
  } catch (err) {
    console.error("Gemini trip-plan generation failed:", err.message);
    // 502 tells the app this specific call failed (not a client mistake) —
    // it falls back to the local rule-based generator, so a Gemini outage
    // or exhausted free-tier quota never actually blocks trip planning.
    return res.status(err.status ?? 502).json({ error: "AI planning is temporarily unavailable — using the standard planner instead.", detail: err.message });
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

  try {
    const parsed = await callGeminiJson(contents);
    const validIds = new Set(destinations.map((d) => d.id));
    const destinationId = typeof parsed.destinationId === "string" && validIds.has(parsed.destinationId) ? parsed.destinationId : null;
    return res.json({
      destinationId,
      days: Number.isInteger(parsed.days) && parsed.days > 0 && parsed.days <= 30 ? parsed.days : null,
      people: Number.isInteger(parsed.people) && parsed.people > 0 && parsed.people <= 20 ? parsed.people : null,
      style: ["backpacker", "comfortable", "premium"].includes(parsed.style) ? parsed.style : null,
      interests: Array.isArray(parsed.interests) ? parsed.interests.filter((i) => typeof i === "string") : [],
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    });
  } catch (err) {
    console.error("Gemini intent-parsing failed:", err.message);
    return res.status(err.status ?? 502).json({ error: "Couldn't interpret that right now.", detail: err.message });
  }
});

module.exports = router;
