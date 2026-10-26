/**
 * The wording of Jourrrney's Privacy Policy, Terms of Service and "data at a
 * glance" page. ONE source of truth: routes/legal.js turns it into the public
 * web pages (Google Play and Meta both need a web address), and
 * scripts/export-legal-for-app.js copies the same text into the app
 * (journey-app/src/data/legalContent.ts) so the in-app screens say exactly the
 * same thing and work offline. Change the words HERE, then run:
 *
 *   node scripts/export-legal-for-app.js
 *
 * Every statement below describes what the code does today. If a feature
 * changes (a new service, a new kind of data), change the matching sentence in
 * the same commit; a policy that says something untrue is worse than none.
 *
 * Shape: { title, sections: [{ heading, body: [ "paragraph" | { list: [...] } | { contact: true } ] }] }
 * `{ contact: true }` becomes "email us at <address>" on the web (the address
 * comes from SUPPORT_EMAIL) and a pointer to the Google Play page in the app.
 */

const UPDATED = "26 October 2026";

const PRIVACY = {
  title: "Privacy Policy",
  sections: [
    {
      heading: "The short version",
      body: [
        {
          list: [
            "You can use Jourrrney without an account.",
            "If you sign in, we keep your email address and name so you can get back to your account.",
            "We do not sell your information, show ads, or use tracking or analytics tools.",
            "What you type to Tia, our trip planner, is sent to AI services so they can write an answer.",
            "You can delete your account and everything we keep about you at any time.",
          ],
        },
      ],
    },
    {
      heading: "What we keep if you sign in",
      body: [
        {
          list: [
            "Your email address, and your name if you gave it to us or signed in with Facebook.",
            "Details you choose to add to your profile: a short bio, languages, where you live, and whether you like the light or dark screen.",
            "A short history of your recent trip-planning questions and lookups (up to 100 notes), so Tia's answers can build on them. You can clear this any time in Settings.",
            "A scrambled copy of the sign-in code we email you. It cannot be read back, and it stops working after 10 minutes.",
          ],
        },
        "If you sign in with Facebook, Facebook tells us your name and email address. We never see your Facebook password, your friends or your posts, and we never post anything for you.",
      ],
    },
    {
      heading: "What stays on your phone",
      body: [
        "These are saved on your phone and are never sent to us: your recent searches, the places you heart, your saved trips, your safety settings and any emergency contacts you add, and the app's look and feel. Removing the app removes them.",
      ],
    },
    {
      heading: "When you plan a trip with Tia",
      body: [
        "To answer you, the app sends your message, the place you are travelling to and from, how many of you are going, and the other trip details you chose, to our server. Our server passes them to AI services (currently Google Gemini and Groq) which write the reply. We do not send your name or email address to them.",
        "Please do not type private details such as passwords, bank details or ID numbers into the chat.",
        "If you are signed in, we also save a short note of what you asked (see above). If you are not signed in, nothing you ask is remembered.",
      ],
    },
    {
      heading: "Your location",
      body: [
        "Jourrrney only uses your location if you allow it, and only to suggest a starting city or show where you are on a map. Your phone's own maps service turns your position into a place name. We do not store your location on our servers, and you can switch it off at any time in your phone's settings.",
      ],
    },
    {
      heading: "Photos",
      body: [
        "If you tap the camera or photo button in the Tia chat, the picture you choose is sent once, through our server, to an AI service to suggest a destination that looks like it. We do not keep the picture.",
      ],
    },
    {
      heading: "Other services the app uses",
      body: [
        "To work, the app talks to a few outside services. They may see your phone's internet address and the search or place name involved, but not your name or email from us.",
        {
          list: [
            "Open-Meteo: weather forecasts and city-name search.",
            "OpenStreetMap and India Post's pincode service: addresses of places.",
            "Wikimedia Commons, Pexels and similar sites: the photos of places you see.",
            "Google Maps and ride apps: only when you tap to open directions or a ride; they then open in that app.",
            "Expo: the service that delivers app updates to your phone.",
          ],
        },
      ],
    },
    {
      heading: "Who we share information with",
      body: [
        "We do not sell your information. We use these companies to run Jourrrney, and each sees only what its job needs:",
        {
          list: [
            "Render: hosts our server and our database, and keeps ordinary server logs (such as the time and internet address of a request) for a short time.",
            "Resend or Brevo: send you the sign-in code by email, so they see your email address.",
            "Google Gemini and Groq: the AI services described above.",
            "Facebook (Meta): only if you choose Sign in with Facebook.",
          ],
        },
        "We may also share information if the law requires it.",
      ],
    },
    {
      heading: "How long we keep it",
      body: [
        "We keep your account information until you delete your account. Your AI history keeps your latest 100 notes until you clear it or delete your account. Server logs are kept by our host for a short time only.",
      ],
    },
    {
      heading: "Deleting your account and data",
      body: [
        "You can do this yourself, at any time:",
        {
          list: [
            "In the app: open Profile, then Settings, then tap Delete my account.",
            "Without the app: go to the Delete account page on our website, enter your email address and the code we send you.",
          ],
        },
        "Deleting removes your email address, name, profile details and AI history from our database straight away. We do not keep a copy. It cannot be undone. Anything saved only on your phone stays there until you remove the app.",
      ],
    },
    {
      heading: "Keeping it safe",
      body: [
        "The app talks to our server over a secure (HTTPS) connection, and your sign-in is kept in your phone's protected storage. No system is perfectly safe, but we only keep what the app needs.",
      ],
    },
    {
      heading: "Children",
      body: ["Jourrrney is not meant for children under 13, and we do not knowingly collect their information."],
    },
    {
      heading: "Changes to this policy",
      body: ["If we change how we handle your information, we will update this page and the date at the top."],
    },
    {
      heading: "Contact us",
      body: [{ contact: true }],
    },
  ],
};

const TERMS = {
  title: "Terms of Service",
  sections: [
    {
      heading: "About Jourrrney",
      body: [
        "Jourrrney is a travel guide for places in India. It gives you ideas, practical tips and safety information. It is not a booking or payment service, and we do not sell tickets, hotel rooms or tours.",
      ],
    },
    {
      heading: "Using the app",
      body: [
        "You can browse without an account. If you make one, please use your own email address and keep your sign-in safe. You are responsible for what happens under your account. You can delete it at any time (see the Privacy Policy).",
        "Please do not misuse Jourrrney: do not try to break it, overload it, copy it in bulk, or get into other people's accounts.",
      ],
    },
    {
      heading: "Use your own judgement",
      body: [
        "Safety ratings, tips and emergency information are general guidance. Conditions change, and nothing here replaces your own judgement or local advice. In an emergency, call your local emergency number (112 in India).",
        "Prices, timings, distances, weather and opening hours are approximate and can be out of date. Check the important details, such as bookings, entry rules and opening times, before you travel.",
      ],
    },
    {
      heading: "Tia and AI suggestions",
      body: [
        "Tia's replies are written by AI. They can be wrong, incomplete or out of date. Treat them as ideas to check, not as facts.",
      ],
    },
    {
      heading: "Photos and other people's content",
      body: [
        "Photos of places come from public sources, and their owners' licences apply. The names of the people who took them are on the Photo credits screen in the app.",
      ],
    },
    {
      heading: "Other services and links",
      body: [
        "Jourrrney links to and works with other services such as maps and ride apps. We do not control them, and their own terms and privacy policies apply when you use them.",
      ],
    },
    {
      heading: "If something goes wrong",
      body: [
        "We try to keep Jourrrney working and accurate, but we provide it as it is, without promises that it will always be available or free of mistakes. As far as the law allows, we are not responsible for losses that come from travel decisions, bookings or plans made using the app.",
        "We may stop or change parts of the app, and we may close an account that is being misused.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: ["If we change these terms, we will update this page and the date at the top. Using the app after that means you accept the change."],
    },
    {
      heading: "Contact us",
      body: [{ contact: true }],
    },
  ],
};

const DATA = {
  title: "Data we collect and why",
  sections: [
    {
      heading: "In short",
      body: ["This page lists every kind of information Jourrrney handles, why, and where it lives. The full detail is in the Privacy Policy."],
    },
    {
      heading: "Kept on our server (only if you sign in)",
      body: [
        {
          list: [
            "Email address and name: so you can sign in and get back to your account.",
            "Bio, languages, where you live, light or dark screen: only if you add them, so they follow you to a new phone.",
            "Recent trip-planning questions (latest 100): so Tia's answers can build on what you asked before. You can clear them in Settings.",
            "A scrambled sign-in code: for 10 minutes, to check the code you type.",
          ],
        },
      ],
    },
    {
      heading: "Sent to AI services when you use Tia",
      body: [
        "Your message, the places you are travelling from and to, and trip details such as how many of you are going. A photo, only if you choose to share one. Never your name or email address.",
      ],
    },
    {
      heading: "Kept only on your phone",
      body: ["Recent searches, hearted places, saved trips, safety settings, emergency contacts you add, and the app's look and feel."],
    },
    {
      heading: "Your location",
      body: ["Only used if you allow it, to suggest a starting city or show you on a map. Not stored on our servers."],
    },
    {
      heading: "What we do not do",
      body: [{ list: ["We do not sell your information.", "We do not show ads.", "We do not use tracking or analytics tools."] }],
    },
    {
      heading: "Deleting it",
      body: ["Open Profile, then Settings, then Delete my account. Everything we keep about you is removed straight away."],
    },
  ],
};

module.exports = { UPDATED, PRIVACY, TERMS, DATA };
