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

const UPDATED = "13 November 2026";

// Two optional facts about the owner, used by the Terms below. Leave them empty and the Terms use general wording
// that is still correct; fill them in and the same sentences name them.
//   OWNER_NAME   a person or a registered company or firm, e.g. "Asha Rao"
//   COURTS_CITY  the city whose courts handle disputes, e.g. "Bengaluru"
const OWNER_NAME = "";
const COURTS_CITY = "";

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
            "Tia's AI answers are for people who are signed in. When you are signed in, what you type to Tia is sent to AI services so they can write an answer.",
            "Without an account, nothing you type to Tia is sent to AI services.",
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
        "Tia's AI answers are for people who are signed in. When you are signed in and ask Tia something that needs AI, the app sends your message, the place you are travelling to and from, how many of you are going, and the other trip details you chose, to our server. Our server passes them to AI services (currently Google Gemini and Groq) which write the reply. We do not send your name or email address to them.",
        "Please do not type private details such as passwords, bank details or ID numbers into the chat.",
        "When you are signed in, we also save a short note of what you asked (see above). If you are not signed in, Tia works only from the guide inside the app: nothing you type is sent to AI services, and nothing you ask is remembered.",
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
        "If you are signed in and tap the camera or photo button in the Tia chat, the picture you choose is sent once, through our server, to an AI service to suggest a destination that looks like it. We do not keep the picture. Without an account, no picture is sent.",
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
      body: [
        "Jourrrney is for people aged 18 and over. We do not knowingly collect information from anyone under 18 who is using it on their own. If you are a parent or guardian and think a child has given us information, please contact us (see below) and we will delete it.",
      ],
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
      heading: "The short version",
      body: [
        {
          list: [
            "Jourrrney is free to use, and you can use most of it without an account.",
            "Tia's replies are written by AI and can be wrong. Check the important details before you travel.",
            "Comfort Index scores, safety tips and emergency information are general guidance, not a promise. Jourrrney is not an emergency service.",
            "Jourrrney does not take bookings or payments. A stay you book is with the property or the site you use, not with us.",
            "Tia's AI features are for people who are signed in. Everything else works without an account.",
            "Please do not misuse the app or use it to harm others.",
            "You can delete your account whenever you like.",
            "These terms follow the laws of India.",
          ],
        },
      ],
    },
    {
      heading: "About Jourrrney",
      body: [
        "Jourrrney is a travel guide for places in India. It gives you ideas, practical tips, safety information and a trip planner called Tia. It is not a booking or payment service, and we do not sell tickets, hotel rooms, tours or transport.",
        OWNER_NAME
          ? `Jourrrney is run from India by ${OWNER_NAME}. In these terms, "we", "us" and "Jourrrney" mean the owner and operator of the Jourrrney app and of the website at jourrrney.in.`
          : `Jourrrney is run from India. In these terms, "we", "us" and "Jourrrney" mean the owner and operator of the Jourrrney app and of the website at jourrrney.in.`,
        "Jourrrney is free to use today. If we ever add something you have to pay for, we will show you the price before you pay, and you will not be charged for anything you did not agree to.",
      ],
    },
    {
      heading: "Agreeing to these terms",
      body: [
        "By using Jourrrney, in the app or on the website, you agree to these terms and to our Privacy Policy. If you do not agree, please do not use it.",
      ],
    },
    {
      heading: "Who can use Jourrrney",
      body: [
        "Jourrrney is for people aged 18 and over. If you are under 18, please use it only together with a parent or guardian who has read these terms and agrees to them for you.",
      ],
    },
    {
      heading: "Your account",
      body: [
        "You can browse without an account. If you sign in, with an emailed code, with Google or with Facebook, you can get back to your account on any phone and use Tia's AI features, which are only for signed-in people.",
        "Use your own email address or your own Google or Facebook account, give us correct details, and keep your sign-in safe. You are responsible for what happens under your account, so tell us at once if you think someone else has got into it.",
        "One person, one account. Please do not make accounts for other people or share yours.",
        "You can delete your account at any time (the Privacy Policy explains how). Deleting it removes the information we keep about you and cannot be undone.",
      ],
    },
    {
      heading: "AI features need an account",
      body: [
        "Tia's AI-written answers, photo ideas and AI trip plans are for people who are signed in. Without an account you can still search for places and use the rest of the app, and Tia can still help with place names from the guide inside the app.",
        "We may limit AI use if it becomes unusually heavy, so the service stays fair for everyone. Please do not try to use the AI features without signing in, for example with bots or by faking a sign-in.",
      ],
    },
    {
      heading: "Tia and AI suggestions",
      body: [
        "Tia's replies are written by AI services run by other companies (the Privacy Policy names them). They can be wrong, incomplete, out of date or not right for you. Treat them as ideas to check, not as facts or professional advice.",
        "Please do not rely on Tia for decisions about your safety, health, money or legal matters. Check with official sources, the places themselves, or a qualified person.",
        "Your messages and, if you choose, photos are sent to those AI services to produce a reply, as the Privacy Policy explains. Please do not type private details such as passwords, bank details or ID numbers.",
        "If a reply is wrong, unsafe or offensive, please tell us using the contact below so we can look into it.",
      ],
    },
    {
      heading: "Use your own judgement",
      body: [
        "Comfort Index scores, safety tips and emergency information are general guidance. They are not an official rating, a guarantee, or a prediction about your trip. Conditions change, and nothing here replaces your own judgement or local advice.",
        "Jourrrney is not an emergency service. It does not call for help or contact anyone for you. In an emergency, call your local emergency number (112 in India).",
        "Prices, timings, distances, weather, transport and opening hours are approximate and can be out of date. Check the important details, such as bookings, entry rules, permits and opening times, before you travel.",
        "You are responsible for your own travel decisions, and for following local laws and the rules of the places you visit.",
      ],
    },
    {
      heading: "Places to stay",
      body: [
        "Jourrrney shows places to stay to help you plan. We are not a hotel or a travel agent, and we do not take bookings or payments for accommodation.",
        "If you book a stay, your agreement is with the property or the booking site you use, not with Jourrrney. We are not responsible for the stay, or for what the property or the site does, including prices, availability, cancellations, refunds, check-in, safety and the condition of the room.",
        "What we show about a place to stay, such as its name, area, level, price range and other details, comes from the property, public sources or our own travel guide. Price ranges are typical prices to help you budget. They are not offers. The price on the property's or booking site's own page when you book is the price you pay, and taxes and fees may be extra.",
        "Details change. Before you book or pay, check the property's own information, including its cancellation and refund rules, what is included, its house rules, and any age, ID or accessibility requirements.",
        "A place appearing in Jourrrney is not an endorsement. We do not inspect properties. Labels such as Budget, Mid-range and Luxury describe a general price level. They are not official star ratings, and they are not a promise of quality or safety.",
        "If we earn money from a link to a place to stay, for example if a partner pays us when you book through it, we will say so next to the link, and it will not cost you more. We will not let a property pay to change its price level or its place in our lists unless we clearly mark it as an advertisement.",
        "If you own or run a place that appears in Jourrrney and something about it is wrong, or you would like it changed or removed, email us using the contact below with the name of the place and what should change. We will look into it quickly.",
      ],
    },
    {
      heading: "What you must not do",
      body: [
        "When you use Jourrrney, please do not:",
        {
          list: [
            "break the law, or help anyone else to;",
            "type or upload anything unlawful, hateful, threatening or sexually explicit, or anything that uses someone else's work or private pictures without permission;",
            "try to break, overload, probe or get around the security of the app, our server or our sign-in;",
            "use bots, scrapers or other automated tools, or copy the app's content in bulk;",
            "copy, change, reverse-engineer or resell the app, except where the law allows it;",
            "get into someone else's account, or pretend to be someone else;",
            "use Tia to make something harmful, or to harass anyone;",
            "use the AI features without signing in, or share an account so that someone else can.",
          ],
        },
      ],
    },
    {
      heading: "What you give us",
      body: [
        "You own what you write and the photos you choose to share. When you use Tia, you let us use them, and send them to our AI services, only to run the app and give you a reply, as the Privacy Policy explains. We do not show what you write to other users, and we do not use it for advertising.",
        "Things saved only on your phone (hearted places, saved trips, recent searches, safety settings) are not kept by us. If you remove the app or lose your phone, we cannot get them back.",
        "If you send us feedback or ideas, we may use them without owing you anything.",
      ],
    },
    {
      heading: "Our content, and other people's content",
      body: [
        "The Jourrrney app, its design, its text, guides and scores, and its software belong to us or to the people who license them to us. You may use the app for your own personal travel planning. We give you a limited, personal permission to do that, which you cannot pass on to anyone else.",
        "Photos of places come from public sources, and their owners' licences apply. The names of the people who took them are on the Photo credits screen in the app. Map and address information comes from open sources such as OpenStreetMap (© OpenStreetMap contributors).",
        "If you think something in Jourrrney, such as a photo or a piece of text, uses your work without permission, email us. Tell us what it is, where you saw it, and that you own it or act for the owner. We will look into it quickly and remove it if it should not be there.",
      ],
    },
    {
      heading: "Other services and links",
      body: [
        "Jourrrney links to and works with other services such as maps and ride apps. We do not control them, and their own terms and privacy policies apply when you use them. Opening one of them is your choice, and we are not responsible for what they do.",
      ],
    },
    {
      heading: "Changes to the app",
      body: [
        "We keep improving Jourrrney. We may add, change or remove features at any time, or stop the app altogether. Where we reasonably can, we will tell you before a big change, such as stopping the app.",
        "The app updates itself over the internet, and some updates may be needed for it to keep working.",
      ],
    },
    {
      heading: "Ending your use",
      body: [
        "You can stop using Jourrrney at any time, and you can delete your account in the app or on our website.",
        "We may suspend or close an account, or block use of the app, if someone breaks these terms, misuses the app, puts other people or our systems at risk, or if the law requires it. Where we reasonably can, we will tell you why.",
        "When an account is closed, your right to use the signed-in features ends. The parts of these terms that are meant to carry on, such as those about our content, our responsibility and the law, stay in force.",
      ],
    },
    {
      heading: "If something goes wrong",
      body: [
        "We try to keep Jourrrney working and accurate, but we provide it as it is, without promises that it will always be available, on time, or free of mistakes.",
        "As far as the law allows, we are not responsible for losses that come from travel decisions, bookings, safety or plans you make using the app, from something an AI reply got wrong, from other services you reach through the app, or from things we could not reasonably control, such as internet or power failures.",
        "As far as the law allows, if we are responsible to you for something, the most we owe you in total is ₹1,000, or what you have paid us in the last 12 months if that is more.",
        "Nothing in these terms takes away a right you have by law that cannot be limited, including your rights as a consumer.",
      ],
    },
    {
      heading: "Law and disagreements",
      body: [
        "These terms follow the laws of India.",
        "If you have a problem, please email us first (see Contact us). Most problems can be sorted out quickly that way.",
        COURTS_CITY
          ? `If we cannot sort it out, the courts at ${COURTS_CITY}, India, can hear the dispute.`
          : "If we cannot sort it out, the courts in India that have the power to hear the dispute can deal with it.",
        "This does not take away any right you have to go to a consumer commission or a court where you live, if the law gives you that right.",
      ],
    },
    {
      heading: "Complaints",
      body: [
        OWNER_NAME
          ? `If you have a complaint about Jourrrney, or about how your information is handled, write to us at the contact below. ${OWNER_NAME} deals with complaints.`
          : "If you have a complaint about Jourrrney, or about how your information is handled, write to us at the contact below. The owner of Jourrrney deals with complaints.",
        "We will tell you we have received your complaint within 24 hours, and we aim to resolve it within 15 days.",
      ],
    },
    {
      heading: "Changes to these terms",
      body: [
        "We may update these terms, for example when the app or the law changes. We will put the new version on this page with a new date, and for important changes we will also tell you in the app where we can. If you keep using Jourrrney after a change, you accept the new terms. If you do not agree, please stop using the app and delete your account.",
      ],
    },
    {
      heading: "The small print",
      body: [
        {
          list: [
            "If a part of these terms turns out not to be enforceable, the rest still applies.",
            "If we do not enforce part of these terms straight away, we can still do so later.",
            "You cannot hand over your rights under these terms to someone else. We may hand ours to whoever takes over Jourrrney.",
            "These terms are written in English. If they are translated, the English version applies.",
            "These terms and the Privacy Policy are the whole agreement between you and us about Jourrrney.",
          ],
        },
      ],
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
        "Only when you are signed in: your message, the places you are travelling from and to, and trip details such as how many of you are going. A photo, only if you choose to share one. Never your name or email address. Without an account, nothing is sent.",
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
