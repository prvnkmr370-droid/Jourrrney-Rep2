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
- **Creating an account with email takes a name and an 18+ confirmation.** `POST /auth/request-code` has three modes (`mode` in the body): `"signin"` (the default) only works for an address that already has an account and otherwise answers `404 { code: "no_account" }`, sending nothing, so the app can offer to create one; `"signup"` needs `firstName`, `lastName` and `ageConfirmed: true` (names are tidied, letters/spaces/apostrophes/hyphens/full stops, up to 40 characters each; plain-words `400`s with `code: "invalid_signup"` or `"age_required"` and the `field`), and the typed details wait beside the emailed code until `POST /auth/verify-code` confirms it, which is the only place an account is ever made (first/last name and `age_confirmed_at` are stored); `"delete"` is what the public delete-account page uses. Typing the details for an address that already has an account just signs it in and overwrites nothing. Google and Facebook sign-ins create accounts as before (no age tick; their name only). `node scripts/test-email-flow.js` covers all of this.
- **Email delivery is real once you configure a provider.** Set
  `RESEND_API_KEY` *or* `BREVO_API_KEY`, plus `EMAIL_FROM`, and
  `POST /auth/request-code` emails the code to the address the user typed
  (`src/lib/mailer.js`). In that mode the code is never logged and never
  returned to the app. Requests are throttled (one per 25 s and six per hour
  per address, twenty per hour per IP). With **no** provider configured and
  running on your own computer, the code is logged and echoed back as `devCode`
  (handy for testing). On a hosted server (`NODE_ENV=production`, or on Render,
  which sets `RENDER=true`) it answers `503` instead and email sign-in is off:
  showing a code to the person asking would let anyone sign in as any email
  address. Google and Facebook sign-in are unaffected. Render's free
  tier blocks SMTP, so both providers are used over HTTPS. Check the whole
  flow without any account: `node scripts/test-email-flow.js`.
- **Facebook sign-in** is built (`src/routes/facebookAuth.js`) and switches on once `FACEBOOK_APP_ID` and `FACEBOOK_APP_SECRET` are set (see `.env.example`). Test it without Facebook: `node scripts/test-facebook-flow.js`.
- **Google sign-in** is built (`src/routes/googleAuth.js`, same browser-based method as Facebook) and switches on once `GOOGLE_WEB_CLIENT_ID` and `GOOGLE_WEB_CLIENT_SECRET` are set (an OAuth client of type "Web application"; redirect URI `<PUBLIC_BASE_URL>/auth/google/callback`). Only emails Google has verified are accepted. The older `POST /auth/google { idToken }` route is unchanged. Test it without Google: `node scripts/test-google-flow.js`. The pieces Facebook and Google share live in `src/lib/oauthLogin.js`.
- **Account deletion** (required by Google Play): `DELETE /auth/account` for a signed-in person, and the public page `/delete-account` (email + emailed code, `POST /auth/delete-with-code`) for someone without the app. Both remove the user, their AI history and any waiting sign-in code in one transaction, and a deleted account's old token stops working at once. Test: `node scripts/test-account-deletion.js` (about 30 s).
- **Public web pages**: the home page `/` (Google wants one, linking to the privacy policy, before Sign in with Google can be published for everyone), plus `/privacy`, `/terms`, `/delete-account` (what Google Play and Meta link to). The wording lives once in `src/legal/content.js`; after changing it run `node scripts/export-legal-for-app.js` to copy it into the app's screens. They show `SUPPORT_EMAIL` as the contact address; set it on Render.
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

## Keeping the database across restarts (Render)

**By default, on Render the SQLite file lives on temporary storage that is wiped on every restart and every deploy, and every account goes with it.** Free web services can't have a disk. The server warns about this in its logs at every start (`[db] WARNING: running on Render without SQLITE_PATH ...`). To keep the data:

1. **Instance type:** change the web service from Free to a paid type (Starter, about $7 a month). That also stops it sleeping when idle.
2. **Disk:** on the service, open **Disk** and click **Add disk**. Mount path `/var/data`, size `1` GB (about $0.25 a month; it can be made bigger later, never smaller). Render deploys when the disk is added.
3. **Setting:** on **Environment**, add `SQLITE_PATH` = `/var/data/data.sqlite` and choose **Save and deploy**. Without this the server keeps writing to temporary storage even with a disk attached.
4. **Check it:** open `https://<your-service>/health/database`. It shows `createdAt` (when the database file was first made), `serverStarts` (how many times a server has started on it) and `pathConfigured`. After the *next* deploy or restart, `createdAt` must be unchanged and `serverStarts` one higher. If `createdAt` is "just now" and `serverStarts` is 1 after a restart, the file was thrown away; `pathConfigured: false` means `SQLITE_PATH` isn't set.

What a disk means: it is attached to one instance only (no scaling out); a deploy stops the old instance before the new one starts, so there are a few seconds of downtime; Render takes a snapshot of the disk every 24 hours and keeps seven days, and a restore replaces the whole disk. Prices are from Render's pricing page and can change.

**This service is managed by a Blueprint (the `render.yaml` in this repo), so make the change there, not only in the dashboard: Render re-applies `render.yaml` on every sync and could undo a dashboard-only change.** `render.yaml` keeps the free plan and has the paid settings (`plan: starter`, a 1 GB `disk` at `/var/data`, `SQLITE_PATH`) written out as a comment; uncommenting them and pushing starts the billing, so do it only once the cost is approved.

`node scripts/test-database-persistence.js` proves on your own machine that an account survives a restart (it stops the server, starts a new one on the same file, and checks the account and `/health/database`).

## Reporting an AI reply

Google Play requires an in-app way to report offensive or harmful AI output. The app shows a **Report** button under each AI-written reply from Tia and next to an AI-written trip plan; it opens a small sheet (reason, optional note) and calls `POST /reports` (`src/routes/reports.js`):

- Signed in only (AI is for signed-in people). Body: `kind` (`chat_reply` | `trip_plan`), `reason` (`wrong` | `unsafe` | `offensive` | `other`), `content` (the reported text, 4000 characters at most), optional `comment` and `context` (500 each). At most 20 reports a person a day.
- It is stored in `ai_reports` (removed with the account) **and a copy is emailed to `SUPPORT_EMAIL`** through the connected email service. **Set `SUPPORT_EMAIL` on Render**: on the free plan the database is wiped on every restart, so the email is the copy that lasts. Without it a report is stored but nobody is told.
- The log line is `[report] #id kind reason`, never the text. `node scripts/test-reports.js` checks all of this.
- The privacy policy and terms describe the button (what is sent and kept); run `node scripts/export-legal-for-app.js` after changing `src/legal/content.js`.

## AI response rules and per-user memory

All three AI routes (`POST /plan-trip/ai`, `/plan-trip/route-info`, `/plan-trip/parse-intent`) now go through `withGuidelines()` in `src/lib/aiMemory.js`:

- **App-wide rules** (`APP_AI_GUIDELINES`): one fixed set of response instructions (honesty, no invented facts, road-vs-straight-line distances, women's-safety precautions, seasonal hazards and permits, inclusive tone, India-only scope) applied to **every** traveller, guests included. Edit that one string to change how the AI behaves everywhere.
- **Per-user memory** (signed-in users only, saved automatically): the typed chat question, a one-line summary of each itinerary request, and each route lookup are stored in the `ai_memory` table (max 100 per user, 500 characters each, photos never stored). The 8 most recent are fed back into that same user's later prompts, wrapped as data (not instructions). Guests have no memory.
- **Controls**: `GET /ai-memory` lists a user's own entries, `DELETE /ai-memory` clears them all, `DELETE /ai-memory/:id` removes one (all require sign-in). The app exposes this as Profile → Settings → "Clear AI history".
- The AI routes use `middleware/optionalAuth.js`, so they stay open to guests but personalise for signed-in users when the app sends its `Authorization: Bearer` token (see `journey-app/src/screens/PlanTrip/aiRequest.ts`).
- Privacy: update the app's privacy policy to mention that signed-in users' AI requests are stored to personalise answers and can be deleted from Settings.

## AI needs sign-in

Signing in is never required to use the app, but the AI is what an account unlocks. The three AI routes (`/plan-trip/ai`, `/route-info`, `/parse-intent`) go through `aiGuestGate` (`src/middleware/aiGuestLimit.js`), after `optionalAuth`:

- **Signed in** (a valid token): not limited here.
- **A guest, by default:** refused. The route answers `403 { code: "login_required" }` before anything is counted or stored, and no AI provider is called. A bad or expired token counts as a guest. Nothing that is not AI (places, search, the rest of the app) is limited.
- `GET /plan-trip/ai-access` says whether the caller can use AI (`{ signedIn: true }`, or `{ signedIn: false, used: 0, limit: 0, remaining: 0 }` for a guest). It calls no AI.
- **Optional "free taste" mode:** set `AI_GUEST_PROMPT_LIMIT` to a number (say `5`) on the host and a guest gets that many free prompts before the route answers `403 { code: "guest_limit" }`. One prompt is one thing the person did (the app sends the same `X-AI-Prompt-Id` on every call that belongs to it); only answered calls count; the count is kept per phone (`X-Device-Id`) or per network address, with a daily per-address cap (`AI_GUEST_IP_DAILY_CAP`, default 60), in the `ai_guest_prompts` table. This mode is OFF unless you set the number, and the privacy policy and terms describe the OFF state: if you turn it on, update `src/legal/content.js` first (the random phone id and the count are then kept).
- `node scripts/test-ai-guest-limit.js` checks both modes against a throwaway copy of the server and a fake AI.
- After changing `src/legal/content.js`, run `node scripts/export-legal-for-app.js`.
