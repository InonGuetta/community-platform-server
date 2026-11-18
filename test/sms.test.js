import "./setup.js";
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { segmentsOf, transmitSms } from "../lib/sms.js";
import { sendSms, recentVerificationSends } from "../services/servicesSms.js";
import { pool } from "../db/pool.js";
import { phoneHash } from "../lib/phone.js";
import { stubPoolQuery } from "./setup.js";
import { logger } from "../lib/logger.js";

// The SMS channel (lib/sms.js) and the cap and record around it
// (services/servicesSms.js, migration 054's sms_usage).

const SMS_ENV = { TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "secret-token", SMS_SENDER: "+15005550006" };
const configure = (on, extra = {}) => {
  for (const [name, value] of Object.entries({ ...SMS_ENV, ...extra })) {
    if (on) process.env[name] = value;
    else delete process.env[name];
  }
};
const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  configure(false, { SMS_MONTHLY_CAP_USD: "", SMS_PRICE_PER_SEGMENT_USD: "" });
});

const TO = "+972545551234";

test("plain Latin text is GSM-7: 160 characters in one segment, 153 in each of several", () => {
  assert.deepEqual(segmentsOf("a".repeat(160)), { encoding: "GSM-7", units: 160, segments: 1 });
  assert.equal(segmentsOf("a".repeat(161)).segments, 2);
  assert.equal(segmentsOf("a".repeat(306)).segments, 2);
  assert.equal(segmentsOf("a".repeat(307)).segments, 3);
  // An extended character takes two septets.
  assert.equal(segmentsOf("€".repeat(80)).units, 160);
});

test("Hebrew — or one letter outside the alphabet — is UCS-2: 70 in one, 67 in each of several", () => {
  assert.deepEqual(segmentsOf("ש".repeat(70)), { encoding: "UCS-2", units: 70, segments: 1 });
  assert.equal(segmentsOf("ש".repeat(71)).segments, 2);
  assert.equal(segmentsOf("Leçon prête").encoding, "UCS-2");
  assert.equal(segmentsOf("Mañana a las 20:00").encoding, "GSM-7");
});

test("with no provider configured, a message is logged, not sent — and no fetch is made", async () => {
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  const result = await transmitSms({ to: TO, body: "קוד: 123456" });
  assert.deepEqual(result, { status: "logged", segments: 1 });
});

test("log mode prints the body in development, never in production — nor the whole number", async () => {
  const lines = [];
  const realInfo = logger.info;
  const realEnv = process.env.NODE_ENV;
  logger.info = (line) => lines.push(String(line));
  try {
    process.env.NODE_ENV = "development";
    await transmitSms({ to: TO, body: "קוד: 654321" });
    process.env.NODE_ENV = "production";
    await transmitSms({ to: TO, body: "קוד: 654321" });
  } finally {
    logger.info = realInfo;
    process.env.NODE_ENV = realEnv;
  }
  assert.equal(lines.length, 2);
  assert.match(lines[0], /654321/);
  assert.doesNotMatch(lines[1], /654321/);
  assert.ok(lines.every((l) => !l.includes(TO)));
});

test("with Twilio configured, one POST with basic auth, the number and the body", async () => {
  configure(true);
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 201, json: async () => ({ sid: "SM1" }) };
  };
  const result = await transmitSms({ to: TO, body: "Code: 123456" });
  assert.deepEqual(result, { status: "sent", segments: 1, providerId: "SM1" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
  assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from("AC123:secret-token").toString("base64")}`);
  const form = calls[0].init.body;
  assert.equal(form.get("To"), TO);
  assert.equal(form.get("From"), "+15005550006");
  assert.equal(form.get("Body"), "Code: 123456");
});

test("a Messaging Service sender is sent as MessagingServiceSid, not From", async () => {
  configure(true, { SMS_SENDER: "MG0001" });
  let form;
  globalThis.fetch = async (_url, init) => { form = init.body; return { ok: true, status: 201, json: async () => ({}) }; };
  await transmitSms({ to: TO, body: "x" });
  assert.equal(form.get("MessagingServiceSid"), "MG0001");
  assert.equal(form.get("From"), null);
});

test("a provider refusal is an answer, not a throw, and carries the provider's code", async () => {
  configure(true);
  globalThis.fetch = async () => ({ ok: false, status: 400, json: async () => ({ code: 21610, message: "unsubscribed" }) });
  const result = await transmitSms({ to: TO, body: "x" });
  assert.equal(result.status, "failed");
  assert.equal(result.providerCode, 21610);
});

test("sendSms records the message with a hash of the number — never the number — and its estimated cost", async () => {
  configure(true, { SMS_PRICE_PER_SEGMENT_USD: "0.25" });
  globalThis.fetch = async () => ({ ok: true, status: 201, json: async () => ({ sid: "SM2" }) });
  const db = stubPoolQuery(pool, (text) => (/RETURNING id/.test(text) ? { rows: [{ id: 31 }] } : { rows: [] }));
  try {
    const result = await sendSms({ userId: 7, to: TO, body: "ש".repeat(71), purpose: "verification" });
    assert.equal(result.status, "sent");
    const texts = db.calls.map((c) => c.text);
    const insert = texts.findIndex((t) => /INSERT INTO sms_usage/.test(t));
    const settle = texts.findIndex((t) => /UPDATE sms_usage SET status/.test(t));
    assert.ok(insert >= 0 && insert < settle, "reserved before it is sent, settled after");
    assert.deepEqual(db.calls[insert].params, [7, "verification", phoneHash(TO)]);
    assert.match(texts[insert], /'sending'/);
    assert.deepEqual(db.calls[settle].params, [31, "sent", 2, 0.5]);
    assert.ok(!JSON.stringify(db.calls).includes(TO), "the number itself never reaches the database");
  } finally {
    db.restore();
  }
});

test("a logged message is recorded at no cost", async () => {
  const db = stubPoolQuery(pool, (text) => (/RETURNING id/.test(text) ? { rows: [{ id: 32 }] } : { rows: [] }));
  try {
    await sendSms({ userId: 7, to: TO, body: "x", purpose: "sessions" });
    const settle = db.calls.find((c) => /UPDATE sms_usage SET status/.test(c.text));
    assert.deepEqual(settle.params, [32, "logged", 1, 0]);
  } finally {
    db.restore();
  }
});

test("a message that could not be reserved is still sent — unrecorded beats unsent", async () => {
  configure(true);
  let posted = 0;
  globalThis.fetch = async () => { posted += 1; return { ok: true, status: 201, json: async () => ({}) }; };
  const db = stubPoolQuery(pool, (text) => { if (/INSERT/.test(text)) throw new Error("db hiccup"); return { rows: [] }; });
  try {
    const result = await sendSms({ userId: 7, to: TO, body: "x", purpose: "sessions" });
    assert.equal(result.status, "sent");
    assert.equal(posted, 1);
    assert.ok(!db.calls.some((c) => /UPDATE sms_usage/.test(c.text)));
  } finally {
    db.restore();
  }
});

test("with no cap set, the spend is not even asked for", async () => {
  const db = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await sendSms({ userId: 7, to: TO, body: "x", purpose: "sessions" });
    assert.ok(!db.calls.some((c) => /SUM\(cost_usd\)/.test(c.text)));
  } finally {
    db.restore();
  }
});

test("at the monthly cap nothing is sent or recorded", async () => {
  configure(true, { SMS_MONTHLY_CAP_USD: "10" });
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  const db = stubPoolQuery(pool, (text) => (/SUM\(cost_usd\)/.test(text) ? { rows: [{ spent: 10 }] } : { rows: [] }));
  try {
    const result = await sendSms({ userId: 7, to: TO, body: "x", purpose: "verification" });
    assert.deepEqual(result, { status: "capped", segments: 0 });
    assert.ok(!db.calls.some((c) => /INSERT/.test(c.text)));
  } finally {
    db.restore();
  }
});

test("a cap that cannot be read fails closed", async () => {
  configure(true, { SMS_MONTHLY_CAP_USD: "10" });
  globalThis.fetch = async () => { throw new Error("must not be called"); };
  const db = stubPoolQuery(pool, () => { throw new Error("db down"); });
  try {
    const result = await sendSms({ userId: 7, to: TO, body: "x", purpose: "verification" });
    assert.equal(result.status, "failed");
  } finally {
    db.restore();
  }
});

test("codes sent to a number are counted by its hash, across every account", async () => {
  const db = stubPoolQuery(pool, () => ({ rows: [{ count: 2, wait_minutes: 17 }] }));
  try {
    assert.deepEqual(await recentVerificationSends({ to: TO }, 60), { count: 2, waitMinutes: 17 });
    assert.deepEqual(db.calls[0].params, [phoneHash(TO), 60]);
    assert.match(db.calls[0].text, /WHERE phone_hash = \$1/);
  } finally {
    db.restore();
  }
});

test("codes sent by one account are counted by the account, and the wait is never under a minute", async () => {
  const db = stubPoolQuery(pool, () => ({ rows: [{ count: 0, wait_minutes: 0 }] }));
  try {
    assert.deepEqual(await recentVerificationSends({ userId: 7 }, 60), { count: 0, waitMinutes: 1 });
    assert.deepEqual(db.calls[0].params, [7, 60]);
    assert.match(db.calls[0].text, /WHERE user_id = \$1/);
  } finally {
    db.restore();
  }
});
