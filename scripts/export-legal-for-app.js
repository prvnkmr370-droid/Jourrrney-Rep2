/**
 * Copies the legal wording (src/legal/content.js) into the app, so the screens
 * inside Jourrrney say exactly what the website pages say:
 *
 *   node scripts/export-legal-for-app.js
 *
 * Writes ../journey-app/src/data/legalContent.ts. Run it whenever content.js
 * changes, and commit the generated file in the app repo alongside.
 */
const fs = require("node:fs");
const path = require("node:path");
const { UPDATED, PRIVACY, TERMS, DATA } = require("../src/legal/content");

const target = path.join(__dirname, "..", "..", "journey-app", "src", "data", "legalContent.ts");

const out = `/**
 * GENERATED FILE. Do not edit by hand.
 * Source: journey-backend/src/legal/content.js
 * Regenerate: (in journey-backend) node scripts/export-legal-for-app.js
 *
 * The same words are served as web pages at /privacy and /terms, which is what
 * the Google Play listing links to.
 */

/** A paragraph, a bulleted list, or the "how to contact us" line. */
export type LegalBlock = string | { list: string[] } | { contact: true };

export interface LegalSection {
  heading: string;
  body: LegalBlock[];
}

export interface LegalDoc {
  title: string;
  sections: LegalSection[];
}

export const LEGAL_UPDATED = ${JSON.stringify(UPDATED)};

export const LEGAL_DOCS: Record<"privacy" | "terms" | "data", LegalDoc> = ${JSON.stringify({ privacy: PRIVACY, terms: TERMS, data: DATA }, null, 2)};
`;

fs.writeFileSync(target, out);
console.log(`Wrote ${path.relative(process.cwd(), target)} (${out.length} bytes)`);
