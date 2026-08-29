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

const MODEL = "gemini-2.5-flash";
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

router.post("/ai", async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: "AI planning isn't configured on this server yet (no GEMINI_API_KEY)." });
  }

  const { destination, style, days, people } = req.body || {};
  if (!destination?.name || !style?.label || !days || !people) {
    return res.status(400).json({ error: "destination, style, days, and people are required" });
  }

  const ai = new GoogleGenAI({ apiKey });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: buildPrompt(req.body),
      config: {
        responseMimeType: "application/json",
        // Keeps this a "generate the plan" call, not a multi-turn chat —
        // deterministic-ish output is more useful than creative variance
        // for something a price estimate is derived from.
        temperature: 0.6,
      },
    });
    clearTimeout(timeout);

    const text = response.text;
    if (!text) throw new Error("Empty response from Gemini");

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("Gemini returned non-JSON output");
    }
    if (!Array.isArray(parsed.itinerary) || parsed.itinerary.length === 0) {
      throw new Error("Malformed itinerary in Gemini response");
    }

    return res.json({ itinerary: parsed.itinerary, tips: Array.isArray(parsed.tips) ? parsed.tips : [], source: "gemini" });
  } catch (err) {
    clearTimeout(timeout);
    console.error("Gemini trip-plan generation failed:", err.message);
    // 502 tells the app this specific call failed (not a client mistake) —
    // it falls back to the local rule-based generator, so a Gemini outage
    // or exhausted free-tier quota never actually blocks trip planning.
    return res.status(502).json({ error: "AI planning is temporarily unavailable — using the standard planner instead.", detail: err.message });
  }
});

module.exports = router;
