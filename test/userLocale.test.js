import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";
import { LANGUAGE_CODES, directionOf, isSupportedLanguage } from "../lib/languages.js";
import { optionalLocale } from "../lib/validate.js";

// The interface language a user reads in (users.locale, migration 051): the
// server keeps it because it words the mail a user gets outside the browser.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const USER = { id: 7, email: "u@example.com", role: "student", is_active: true, display_name: "דוד", locale: "he" };
const tokenFor = (u) => jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const capture = () => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/UPDATE users/i.test(text)) return { rows: [{ ...USER, locale: params[2] ?? USER.locale }] };
    if (/INSERT INTO users/i.test(text)) return { rows: [{ ...USER, locale: params[5] ?? "he" }] };
    if (/FROM users/i.test(text)) return { rows: [USER] };
    return { rows: [] };
  });
  return calls;
};

const patchMe = (body) =>
  request(app).patch("/api/auth/me").set("Cookie", `token=${tokenFor(USER)}`).send(body);

// ── The list ────────────────────────────────────────────────────────────────

test("five languages; Hebrew and Yiddish are right to left", () => {
  assert.deepEqual([...LANGUAGE_CODES], ["he", "yi", "en", "fr", "es"]);
  assert.equal(directionOf("yi"), "rtl");
  assert.equal(directionOf("fr"), "ltr");
  assert.equal(isSupportedLanguage("de"), false);
});

test("migration 051's CHECK holds exactly the server's list", () => {
  const sql = fs.readFileSync(new URL("../db/migrations/051_user_locale.sql", import.meta.url), "utf8");
  const listed = sql.match(/locale IN \(([^)]+)\)/)?.[1].match(/'([^']+)'/g)?.map((q) => q.slice(1, -1));
  assert.ok(listed?.length, "the CHECK's list was not found in the migration");
  assert.deepEqual(listed, [...LANGUAGE_CODES]);
});

// ── The guard ───────────────────────────────────────────────────────────────

test("optionalLocale: absent is null, ours passes, anything else is a 400", () => {
  assert.equal(optionalLocale(undefined), null);
  assert.equal(optionalLocale(null), null);
  assert.equal(optionalLocale("en"), "en");
  for (const bad of ["de", "EN", "", 3, ["he"]]) {
    assert.throws(() => optionalLocale(bad), (err) => err.statusCode === 400, `accepted ${JSON.stringify(bad)}`);
  }
});

// ── Reading it ──────────────────────────────────────────────────────────────

test("GET /me returns the user's language", async () => {
  const calls = capture();
  const res = await request(app).get("/api/auth/me").set("Cookie", `token=${tokenFor(USER)}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.locale, "he");
  assert.ok(calls.some((c) => /SELECT[\s\S]*\blocale\b[\s\S]*FROM users/i.test(c.text)));
});

// ── Changing it ─────────────────────────────────────────────────────────────

test("PATCH /me with only a language changes only the language", async () => {
  const calls = capture();
  const res = await patchMe({ locale: "en" });
  assert.equal(res.status, 200);
  assert.equal(res.body.locale, "en");
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.deepEqual(update.params, [null, null, "en", USER.id]);
});

test("PATCH /me without a language leaves it alone", async () => {
  const calls = capture();
  const res = await patchMe({ displayName: "משה" });
  assert.equal(res.status, 200);
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.equal(update.params[2], null);
  assert.match(update.text, /locale\s*=\s*COALESCE\(\$3, locale\)/);
});

test("PATCH /me refuses a language we do not have, before any write", async () => {
  const calls = capture();
  const res = await patchMe({ locale: "de" });
  assert.equal(res.status, 400);
  assert.equal(calls.filter((c) => /UPDATE users/i.test(c.text)).length, 0);
});

// ── A new account ───────────────────────────────────────────────────────────

test("registering in a language starts the account in it", async () => {
  const calls = capture();
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/SELECT id FROM users WHERE email/i.test(text)) return { rows: [] };
    if (/INSERT INTO users/i.test(text)) return { rows: [{ ...USER, locale: params[5] }] };
    return { rows: [] };
  });
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "new@example.com", password: "a-long-enough-password-1", locale: "fr" });
  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO users/i.test(c.text));
  assert.equal(insert.params[5], "fr");
  assert.match(insert.text, /COALESCE\(\$6, 'he'\)/);
});

test("registering in an unknown language is refused", async () => {
  capture();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "new@example.com", password: "a-long-enough-password-1", locale: "xx" });
  assert.equal(res.status, 400);
});
