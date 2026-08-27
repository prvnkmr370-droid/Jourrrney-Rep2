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
- **Not real yet — no email is actually sent.** There's no email provider
  wired up (see the honesty note at the top of `src/routes/auth.js`). The
  code is logged to this server's console, and — only outside
  `NODE_ENV=production` — echoed back to the app as `devCode` so you can
  test the whole flow without an inbox. Before using this for real users,
  plug in an email provider (Resend, SendGrid, Postmark, etc.) and remove
  that dev-only echo.
- **Not implemented**: Google/Apple/Facebook sign-in still just mark the
  user signed in locally in the app — those need real OAuth credentials
  from each provider (a Google Cloud project, an Apple Developer Program
  enrollment, a Facebook Developer app) that only you can create. Once you
  have credentials for any of them, this backend can be extended to verify
  those tokens the same way it verifies the email code now.
- **Not implemented**: profile data (bio, personal info, avatar), Safety
  Guard contacts, and travel preferences are still local-only on the
  device — this first pass only covers authentication, per your original
  scope choice. Ask to extend this backend to persist that data whenever
  you're ready.

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
