import "./setup.js";
import test, { after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import { hashCode, MAX_ATTEMPTS, codeMessage } from "../services/servicesPhone.js";
import { phoneCodeOf } from "../lib/validate.js";
import { segmentsOf } from "../lib/sms.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Proving a mobile number with a code by SMS (services/servicesPhone.js,
// migration 054): the code is hashed, limited, spent on every wrong try, and a
// right one moves the number to this account.

const app = createApp();
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// A new account for each test: the routes' own limit counts per user, and one
// account sending every request in this file would reach it.
let nextUserId = 10;
let USER;
let cookie;
beforeEach(() => {
  USER = { id: nextUserId++, email: "u@example.com", role: "student" };
  cookie = `token=${jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
});
const PHONE = "+972545551234";

// Twilio "configured", with every message it is handed kept here.
const SMS_ENV = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", SMS_SENDER: "+15005550006" };
const realFetch = globalThis.fetch;
let sent = [];
const twilio = ({ ok = true } = {}) => {
  Object.assign(process.env, SMS_ENV);
  sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push({ to: init.body.get("To"), body: init.body.get("Body") });
    return ok
      ? { ok: true, status: 201, json: async () => ({ sid: "SM1" }) }
      : { ok: false, status: 500, json: async () => ({ message: "down" }) };
  };
};
const restores = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of Object.keys(SMS_ENV)) delete process.env[name];
  while (restores.length) restores.pop()();
});

// verifyToken reads the caller's row first, on every request.
const AUTH_SQL = /FROM users WHERE id=\$1 AND is_active=TRUE/;
const isAuth = (text) => AUTH_SQL.test(text);

const STATE_ROW = { phone_e164: null, phone_verified_at: null, phone_pending: PHONE, phone_pending_expires_at: "2026-11-18T12:10:00Z" };

/**
 * The database for the start of a verification. `user` is the account row,
 * `sends` the codes counted in the last hour ({ byUser, toNumber }).
 */
const givenStart = ({ user = {}, sends = {} } = {}) => {
  // The pool and the transaction's client answer alike; `calls` holds both,
  // in the order they were sent.
  const calls = [];
  const answer = (text, params) => {
    calls.push({ text, params });
    if (isAuth(text)) return { rows: [USER] };
    if (/INSERT INTO sms_usage/.test(text)) return { rows: [{ id: 5 }] };
    if (/SELECT u\.locale/.test(text)) {
      return { rows: [{ locale: "he", phone_e164: null, phone_verified_at: null, last_sent_at: null, ...user }] };
    }
    if (/FROM sms_usage/.test(text)) {
      const count = /phone_hash = \$1/.test(text) ? sends.toNumber ?? 0 : sends.byUser ?? 0;
      return { rows: [{ count, wait_minutes: 42 }] };
    }
    if (/FROM users u LEFT JOIN phone_verifications pv ON pv.user_id = u.id AND pv.expires_at/.test(text)) {
      return { rows: [STATE_ROW] };
    }
    return { rows: [] };
  };
  const db = stubPoolQuery(pool, answer);
  const tx = stubPoolConnect(pool, answer);
  restores.push(db.restore, tx.restore);
  return { calls };
};

test("a number that is not one is refused before anything is read or sent", async () => {
  twilio();
  const db = givenStart();
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: "12" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PHONE_INVALID");
  assert.ok(db.calls.every((c) => isAuth(c.text)), "nothing but the caller's own row is read");
  assert.equal(sent.length, 0);
});

test("a landline is refused with its own code", async () => {
  givenStart();
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: "02-6234567" });
  assert.equal(res.body.code, "PHONE_NOT_MOBILE");
});

test("a code goes by SMS to the number typed, and only its hash is stored", async () => {
  twilio();
  const db = givenStart();
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: "054-555-1234", userId: 99 });
  assert.equal(res.status, 200);
  assert.equal(res.body.phone_pending, PHONE);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  const code = sent[0].body.match(/\d{6}/)?.[0];
  assert.ok(code, "the SMS carries a six-digit code");

  const insert = db.calls.find((c) => /INSERT INTO phone_verifications/.test(c.text));
  assert.equal(insert.params[0], USER.id, "the caller's own id, never one from the body");
  assert.equal(insert.params[1], PHONE);
  assert.equal(insert.params[2], hashCode(USER.id, PHONE, code));
  assert.ok(!JSON.stringify(db.calls).includes(`"${code}"`), "the code itself never reaches the database");
});

test("the code's SMS is one segment in every language", () => {
  for (const lng of ["he", "yi", "en", "fr", "es"]) {
    const text = codeMessage(lng, "123456");
    assert.match(text, /123456/, lng);
    assert.equal(segmentsOf(text).segments, 1, `${lng}: "${text}"`);
  }
});

test("a second code within a minute is refused", async () => {
  twilio();
  givenStart({ user: { last_sent_at: new Date(Date.now() - 20_000) } });
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "PHONE_SEND_LIMIT");
  assert.deepEqual(res.body.params, { minutes: 1 });
  assert.equal(sent.length, 0);
});

test("three codes an hour to one number — from any account — and the fourth waits", async () => {
  twilio();
  givenStart({ sends: { toNumber: 3 } });
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "PHONE_SEND_LIMIT");
  assert.deepEqual(res.body.params, { minutes: 42 });
  assert.equal(sent.length, 0);
});

test("three codes an hour from one account, whatever numbers it tries", async () => {
  twilio();
  givenStart({ sends: { byUser: 3 } });
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  assert.equal(res.body.code, "PHONE_SEND_LIMIT");
});

test("an SMS that could not go leaves no code to type back — but still counts toward the hour", async () => {
  twilio({ ok: false });
  const db = givenStart();
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  assert.equal(res.status, 503);
  assert.equal(res.body.code, "SMS_FAILED");
  assert.ok(db.calls.some((c) => /DELETE FROM phone_verifications/.test(c.text)));
  const settle = db.calls.find((c) => /UPDATE sms_usage SET status/.test(c.text));
  assert.equal(settle.params[1], "failed");
  assert.ok(!db.calls.some((c) => /DELETE FROM sms_usage/.test(c.text)));
});

test("the limits are counted and the send reserved under locks on the number, then the account", async () => {
  twilio();
  const db = givenStart();
  await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  const texts = db.calls.map((c) => c.text);
  const locks = db.calls.filter((c) => /pg_advisory_xact_lock/.test(c.text)).map((c) => c.params[0]);
  assert.equal(locks.length, 2);
  assert.match(locks[0], /^phone-number:[0-9a-f]{64}$/, "the number's lock first, by its hash");
  assert.equal(locks[1], `phone-user:${USER.id}`);
  const begin = texts.indexOf("BEGIN");
  const commit = texts.indexOf("COMMIT");
  const counted = texts.findIndex((t) => /FROM sms_usage/.test(t));
  const reserved = texts.findIndex((t) => /INSERT INTO sms_usage/.test(t));
  assert.ok(begin < counted && counted < reserved && reserved < commit, "counted and reserved inside one transaction");
  assert.ok(sent.length === 1 && texts.findIndex((t) => /UPDATE sms_usage SET status/.test(t)) > commit, "sent after it commits");
});

test("at the month's SMS cap no code is sent", async () => {
  twilio();
  process.env.SMS_MONTHLY_CAP_USD = "5";
  try {
    const db = givenStart();
    const spend = stubPoolQuery(pool, (text) =>
      /SUM\(cost_usd\)/.test(text) ? { rows: [{ spent: 5 }] } : isAuth(text) ? { rows: [USER] } : { rows: [] });
    restores.push(spend.restore);
    const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
    assert.equal(res.status, 429);
    assert.equal(res.body.code, "SMS_BUDGET_EXCEEDED");
    assert.equal(sent.length, 0);
    assert.ok(!db.calls.some((c) => /INSERT INTO phone_verifications/.test(c.text)));
  } finally {
    delete process.env.SMS_MONTHLY_CAP_USD;
  }
});

test("the account's own verified number needs no code", async () => {
  twilio();
  givenStart({ user: { phone_e164: PHONE, phone_verified_at: new Date() } });
  const res = await request(app).post("/api/auth/me/phone").set("Cookie", cookie).send({ phone: PHONE });
  assert.equal(res.status, 200);
  assert.equal(sent.length, 0);
});

// ── The code typed back ─────────────────────────────────────────────────────

const RIGHT = "481516";
/** A waiting code in a transaction, and every statement it is sent. */
const givenPending = ({ attempts = 0, expired = false, movedFrom = null } = {}) => {
  const tx = stubPoolConnect(pool, (text) => {
    if (/FROM phone_verifications WHERE user_id = \$1 FOR UPDATE/.test(text)) {
      return { rows: [{ phone_e164: PHONE, code_hash: hashCode(USER.id, PHONE, RIGHT), attempts, expired }] };
    }
    if (/RETURNING id/.test(text)) return { rows: movedFrom ? [{ id: movedFrom }] : [] };
    return { rows: [] };
  });
  const db = stubPoolQuery(pool, (text) =>
    isAuth(text) ? { rows: [USER] } : { rows: [{ phone_e164: PHONE, phone_verified_at: new Date(), phone_pending: null }] });
  restores.push(tx.restore, db.restore);
  return tx;
};

test("a wrong code spends an attempt — and the count is committed, not rolled back", async () => {
  const tx = givenPending();
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: "000000" });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PHONE_CODE_INVALID");
  assert.deepEqual(res.body.params, { attemptsLeft: MAX_ATTEMPTS - 1 });
  const texts = tx.calls.map((c) => c.text);
  assert.ok(texts.some((t) => /UPDATE phone_verifications SET attempts/.test(t)));
  assert.ok(texts.includes("COMMIT"));
  assert.ok(!texts.includes("ROLLBACK"));
  assert.ok(!texts.some((t) => /UPDATE users/.test(t)), "a wrong code changes nothing on the account");
});

test("garbage is a wrong code like any other, not a free try", async () => {
  const tx = givenPending();
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: { $ne: "" } });
  assert.equal(res.body.code, "PHONE_CODE_INVALID");
  assert.ok(tx.calls.some((c) => /SET attempts/.test(c.text)));
});

test("the last wrong attempt ends the code", async () => {
  const tx = givenPending({ attempts: MAX_ATTEMPTS - 1 });
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: "000000" });
  assert.equal(res.status, 429);
  assert.equal(res.body.code, "PHONE_CODE_LIMIT");
  assert.ok(tx.calls.some((c) => /DELETE FROM phone_verifications/.test(c.text)));
});

test("even the right code is refused once the attempts are spent", async () => {
  givenPending({ attempts: MAX_ATTEMPTS });
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: RIGHT });
  assert.equal(res.body.code, "PHONE_CODE_LIMIT");
});

test("an expired code is refused, and cleared", async () => {
  const tx = givenPending({ expired: true });
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: RIGHT });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PHONE_CODE_EXPIRED");
  assert.ok(tx.calls.some((c) => /DELETE FROM phone_verifications/.test(c.text)));
});

test("the right code — spaces and all — makes the number this account's", async () => {
  const tx = givenPending();
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: "481 516" });
  assert.equal(res.status, 200);
  assert.equal(res.body.phone, PHONE);
  const set = tx.calls.find((c) => /UPDATE users SET phone_e164 = \$1, phone_verified_at = NOW\(\)/.test(c.text));
  assert.deepEqual(set.params, [PHONE, USER.id]);
  assert.ok(tx.calls.some((c) => /DELETE FROM phone_verifications/.test(c.text)));
});

test("a number verified on another account moves here, and that account loses its SMS choices", async () => {
  const tx = givenPending({ movedFrom: 77 });
  const res = await request(app).post("/api/auth/me/phone/verify").set("Cookie", cookie).send({ code: RIGHT });
  assert.equal(res.status, 200);
  const texts = tx.calls.map((c) => c.text);
  const moved = texts.findIndex((t) => /WHERE phone_e164 = \$1 AND phone_verified_at IS NOT NULL AND id <> \$2/.test(t));
  const taken = texts.findIndex((t) => /UPDATE users SET phone_e164 = \$1, phone_verified_at = NOW\(\)/.test(t));
  assert.ok(moved >= 0 && moved < taken, "the other account lets go before this one takes it");
  const optOut = tx.calls.find((c) => /DELETE FROM notification_sms_optins/.test(c.text));
  assert.deepEqual(optOut.params, [77]);
});

test("removing the number clears it, a waiting code and every SMS choice, together", async () => {
  const tx = stubPoolConnect(pool, () => ({ rows: [] }));
  const db = stubPoolQuery(pool, (text) =>
    isAuth(text) ? { rows: [USER] } : { rows: [{ phone_e164: null, phone_verified_at: null }] });
  restores.push(tx.restore, db.restore);
  const res = await request(app).delete("/api/auth/me/phone").set("Cookie", cookie);
  assert.equal(res.status, 200);
  assert.equal(res.body.phone, null);
  const texts = tx.calls.map((c) => c.text);
  assert.equal(texts[0], "BEGIN");
  assert.ok(texts.some((t) => /UPDATE users SET phone_e164 = NULL/.test(t)));
  assert.ok(texts.some((t) => /DELETE FROM phone_verifications/.test(t)));
  assert.ok(texts.some((t) => /DELETE FROM notification_sms_optins/.test(t)));
  assert.ok(tx.calls.every((c) => !c.params || c.params[0] === USER.id));
});

test("phoneCodeOf takes out what autofill and pasting bring, and nothing that is not a string", () => {
  assert.equal(phoneCodeOf(" 481-516 "), "481516");
  assert.equal(phoneCodeOf(481516), "");
  assert.equal(phoneCodeOf(null), "");
});

test("signed out, none of the three answers", async () => {
  for (const [method, url] of [["post", "/api/auth/me/phone"], ["post", "/api/auth/me/phone/verify"], ["delete", "/api/auth/me/phone"]]) {
    const res = await request(app)[method](url).send({});
    assert.equal(res.status, 401, `${method} ${url}`);
  }
});
