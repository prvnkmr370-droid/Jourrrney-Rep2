# Journey Backend

Custom Node/Express backend for the Jourrrney app. Real email + one-time-code
authentication, backed by a local SQLite file (`data.sqlite`, created
automatically). No external services required to run it.

## Run it

```bash
cd journey-backend
npm install        # first time only
cp .env.example .env
npm run dev
```

It listens on `http://0.0.0.0:4000` — reachable from your phone over the
same Wi-Fi your Mac is on, same as the Expo dev server. Find your Mac's LAN
IP with `ipconfig getifaddr en0` (or `en1`), and put
`http://<that-ip>:4000` into the app's `EXPO_PUBLIC_API_URL` (see
`journey-app/.env`).

**Keep this running in its own terminal, separate from `npx expo start`.**
Both need to be up for sign-in to work.

## What's real vs. not yet

- **Real**: the email → 6-digit-code flow is a genuine server-side
  challenge — the code is generated, hashed, and stored server-side, and
  wrong/expired codes are actually rejected. Sessions are real signed JWTs.
- **Email delivery is real once you configure a provider.** Set
  `RESEND_API_KEY` *or* `BREVO_API_KEY`, plus `EMAIL_FROM`, and
  `POST /auth/request-code` emails the code to the address the user typed
  (`src/lib/mailer.js`). In that mode the code is never logged and never
  returned to the app. Requests are throttled (one per 25 s and six per hour
  per address, twenty per hour per IP). With **no** provider configured it
  behaves as before: the code is logged and, outside `NODE_ENV=production`,
  echoed back as `devCode`; in production it answers `503`. Render's free
  tier blocks SMTP, so both providers are used over HTTPS. Check the whole
  flow without any account: `node scripts/test-email-flow.js`.
- **Facebook sign-in** is built (`src/routes/facebookAuth.js`) and switches on once `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` are set (see `.env.example`). Test it without Facebook: `node scripts/test-facebook-flow.js`.
- **Google sign-in** is built (`src/routes/googleAuth.js`, same browser-based method as Facebook) and switches on once `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_WEB_CLIENT_SECRET` are set (an OAuth client of type "Web application"; redirect URI `<PUBLIC_BASE_URL>/auth/google/callback`). Only emails Google has verified are accepted. The older `POST /auth/google { idToken }` route is unchanged. Test it without Google: `node scripts/test-google-flow.js`. The pieces Facebook and Google share live in `src/lib/oauthLogin.js`.
- **Account deletion** (required by Google Play): `DELETE /auth/account` for a signed-in person, and the public page `/delete-account` (email + emailed code, `POST /auth/delete-with-code`) for someone without the app. Both remove the user, their AI history and any waiting sign-in code in one transaction, and a deleted account's old token stops working at once. Test: `node scripts/test-account-deletion.js` (about 30 s).
- **Public legal pages**: `/privacy`, `/terms`, `/delete-account` (what Google Play and Meta link to). The wording lives once in `src/legal/content.js`; after changing it run `node scripts/export-legal-for-app.js` to copy it into the app's screens. They show `SUPPORT_EMAIL` as the contact address; set it on Render.
- **Not implemented**: Google/Apple sign-in in the app still just mark the
  user signed in locally in the app — those need real OAuth credentials
  from each provider (a Google Cloud project, an Apple Developer Program
  enrollment) that only you can create. Once you
  have credentials for any of them, this backend can be extended to verify
  those tokens the same way it verifies the email code now.
- **Not implemented**: profile data (bio, personal info, avatar), Safety
  Guard contacts, and travel preferences are still local-only on the
  device — this first pass only covers authentication, per your original
  scope choice. Ask to extend this backend to persist that data whenever
  you're ready.
- **Real, but optional**: `POST /plan-trip/ai` (`src/routes/planTrip.js`)
  generates a real AI itinerary via Google's Gemini API (genuinely free
  tier — get a key at [ai.google.dev](https://ai.google.dev), no card
  required). Set `GEMINI_API_KEY` in `.env` (local) or the Render
  dashboard's Environment tab (deployed) to turn it on. Leave it unset and
  the route responds `503` — the app already falls back to its local
  rule-based planner (`generateItinerary()` in
  `journey-app/src/screens/PlanTrip/data.ts`) whenever this endpoint is
  unavailable for any reason (no key, network hiccup, free-tier quota
  used up), so this is additive, never a hard dependency.

## Deploying this for real

Deployed on [Render](https://render.com) via `render.yaml` (a "Blueprint" —
Render reads this file and configures the service automatically). See the
walkthrough that came with this change for the exact steps.

**Known limitation on Render's free tier: the SQLite file (`data.sqlite`)
does not survive a redeploy.** Free web services there don't include
persistent disk storage, so every account created lives only until the
next deploy or restart wipes the container's filesystem. Fine for
continuing to test the deploy pipeline and the auth flow itself; not fine
for real users who expect their account to still exist next week. Fixing
that means either paying for Render's persistent disk add-on, or swapping
SQLite for a real hosted database (Render/Supabase/Neon all have free
Postgres tiers) — ask to do that whenever you're ready to move past
testing.

## AI response rules and per-user memory

All three AI routes (`POST /plan-trip/ai`, `/plan-trip/route-info`, `/plan-trip/parse-intent`) now go through `withGuidelines()` in `src/lib/aiMemory.js`:

- **App-wide rules** (`APP_AI_GUIDELINES`): one fixed set of response instructions (honesty, no invented facts, road-vs-straight-line distances, women's-safety precautions, seasonal hazards and permits, inclusive tone, India-only scope) applied to **every** traveller, guests included. Edit that one string to change how the AI behaves everywhere.
- **Per-user memory** (signed-in users only, saved automatically): the typed chat question, a one-line summary of each itinerary request, and each route lookup are stored in the `ai_memory` table (max 100 per user, 500 characters each, photos never stored). The 8 most recent are fed back into that same user's later prompts, wrapped as data (not instructions). Guests have no memory.
- **Controls**: `GET /ai-memory` lists a user's own entries, `DELETE /ai-memory` clears them all, `DELETE /ai-memory/:id` removes one (all require sign-in). The app exposes this as Profile → Settings → "Clear AI history".
- The AI routes use `middleware/optionalAuth.js`, so they stay open to guests but personalise for signed-in users when the app sends its `Authorization: Bearer` token (see `journey-app/src/screens/PlanTrip/aiRequest.ts`).
- Privacy: update the app's privacy policy to mention that signed-in users' AI requests are stored to personalise answers and can be deleted from Settings.
