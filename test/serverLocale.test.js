import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { requestLocale, hebrewKeys } from "../lib/i18n.js";
import { sessionCalendar } from "../lib/ics.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// What the server renders for a browser — the share page, the document error
// page, a calendar file — is in the language the request names: ?lang= (the
// client adds it to the links it builds), else Accept-Language, else Hebrew.

const app = createApp();

// The app opens the queues; left open they keep the test process alive.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

test("?lang wins, then Accept-Language by weight, then Hebrew", () => {
  assert.equal(requestLocale({ query: { lang: "en" }, headers: { "accept-language": "fr" } }), "en");
  assert.equal(requestLocale({ query: { lang: "de" }, headers: { "accept-language": "fr-FR,fr;q=0.9" } }), "fr");
  assert.equal(requestLocale({ headers: { "accept-language": "de-DE,es;q=0.5,en;q=0.8" } }), "en");
  assert.equal(requestLocale({ headers: { "accept-language": "iw" } }), "he");
  assert.equal(requestLocale({ headers: { "accept-language": "de" } }), "he");
  assert.equal(requestLocale({}), "he");
});

test("the share page is framed in the request's language", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const en = await request(app).get("/api/public/share/7?lang=en");
    assert.match(en.text, /<html lang="en" dir="ltr">/);
    const yi = await request(app).get("/api/public/share/7").set("Accept-Language", "yi");
    assert.match(yi.text, /<html lang="yi" dir="rtl">/);
    const he = await request(app).get("/api/public/share/7");
    assert.match(he.text, /<html lang="he" dir="rtl">/);
    assert.match(he.text, /og:locale" content="he_IL"/);
  } finally {
    stub.restore();
  }
});

test("a calendar file's own labels are in the reader's language; its title is content", () => {
  const base = { id: 4, startsAt: new Date("2026-11-03T17:30:00Z"), hostName: "הרב לוי", url: "https://x/sessions", domain: "x" };
  assert.match(sessionCalendar({ ...base, locale: "he" }), /DESCRIPTION:מארח: הרב לוי/);
  assert.match(sessionCalendar({ ...base, title: null, locale: "he" }), /SUMMARY:מפגש חי/);
  assert.match(sessionCalendar({ ...base, title: "שיעור ערב", locale: "en" }), /SUMMARY:שיעור ערב/);
});

// Every key the server asks for exists in Hebrew, the fallback of every
// language: a missing one would reach a reader as "mail.x.y".
test("every key the server words exists in locales/he.json", () => {
  const files = [
    "lib/mailer.js",
    "lib/ics.js",
    "controllers/controllersPublic.js",
    "controllers/controllersMediaFiles.js",
  ];
  const asked = new Set();
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    for (const m of source.matchAll(/\bt\("([\w.]+)"/g)) asked.add(m[1]);
    for (const m of source.matchAll(/translate\([^,]+, "([\w.]+)"/g)) asked.add(m[1]);
    for (const m of source.matchAll(/"((?:documentPage|share|calendar)\.\w+)"/g)) asked.add(m[1]);
  }
  assert.ok(asked.size > 40, `only ${asked.size} keys found — the scan is broken`);
  const known = new Set(hebrewKeys());
  for (const key of asked) assert.ok(known.has(key), `${key} is missing from locales/he.json`);
});
