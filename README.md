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

Right now this only runs on your own Mac, reachable over your home Wi-Fi —
fine for development, but your phone (and nobody else) can only reach it
while your Mac is on, awake, and on the same network. To make it reachable
from anywhere, you'd deploy it to a host (Render, Railway, Fly.io, a VPS,
etc.), point `EXPO_PUBLIC_API_URL` at that public URL, and swap SQLite for
a hosted database if you expect real concurrent traffic. Say the word when
you're ready for that step and I can help you set it up.
