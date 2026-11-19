import "./setup.js";
import test, { after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  deliver,
  NOTIFICATION_TYPES,
  EMAIL_CATEGORIES,
  SMS_CATEGORIES,
  smsAllowedNow,
} from "../services/servicesNotifications.js";
import { notificationSms, MAX_SEGMENTS } from "../lib/smsText.js";
import { segmentsOf, verifyTwilioSignature, isStopReply } from "../lib/sms.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Notifications by SMS (PRD AUTH-13, migration 054): which go, worded how
// short, never at night, switched per channel, and stopped by a STOP reply.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});
const app = createApp();

const SMS_ENV = { TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tw-token", SMS_SENDER: "+15005550006" };
const realFetch = globalThis.fetch;
const restores = [];
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const name of [...Object.keys(SMS_ENV), "SMS_WEBHOOK_URL"]) delete process.env[name];
  while (restores.length) restores.pop()();
});
const stub = (impl) => {
  const s = stubPoolQuery(pool, impl);
  restores.push(s.restore);
  return s;
};

const INSERT = /INSERT INTO notifications/;
const PHONE = "+972545551234";
const LANGUAGES = ["he", "yi", "en", "fr", "es"];
const SMS_TYPES = [
  "session_scheduled", "session_reminder", "session_starting",
  "processing_done", "processing_error", "course_join_approved", "course_join_rejected",
];

// ── Wording ─────────────────────────────────────────────────────────────────

test("every type an SMS category holds has an SMS wording, in every language, with its link", () => {
  const typesInSms = SMS_CATEGORIES.flatMap((c) => EMAIL_CATEGORIES[c].types);
  assert.deepEqual([...typesInSms].sort(), [...SMS_TYPES].sort());
  const payload = { title: "שיעור", courseTitle: "גמרא", mediaId: 4, startsAt: "2026-11-20T17:30:00Z" };
  for (const type of SMS_TYPES) {
    for (const lng of LANGUAGES) {
      const text = notificationSms(type, payload, lng);
      assert.ok(text, `${type} in ${lng}`);
      assert.doesNotMatch(text, /\{\{|sms\.notify/, `${type} in ${lng} is worded: ${text}`);
      assert.match(text, /\nhttp/, `${type} in ${lng} links to its page`);
    }
  }
});

test("a long title is cut so the message stays within its segments", () => {
  const title = "הלכות שבת — ".repeat(20);
  for (const lng of LANGUAGES) {
    const text = notificationSms("session_starting", { title }, lng);
    assert.ok(segmentsOf(text).segments <= MAX_SEGMENTS, `${lng}: ${segmentsOf(text).segments} segments`);
    assert.match(text, /…/);
  }
});

test("a type no SMS carries has no SMS wording", () => {
  assert.equal(notificationSms("new_lesson", { title: "x" }, "he"), null);
  assert.equal(notificationSms("role_request", {}, "he"), null);
  assert.equal(notificationSms("phone_moved", {}, "he"), null);
});

test("no SMS between 22:00 and 07:00 Israel time — but a session that has just started", () => {
  const at = (iso) => new Date(iso);
  // November: Israel is UTC+2.
  assert.equal(smsAllowedNow("session_reminder", at("2026-11-18T08:00:00Z")), true, "10:00");
  assert.equal(smsAllowedNow("session_reminder", at("2026-11-18T19:59:00Z")), true, "21:59");
  assert.equal(smsAllowedNow("session_reminder", at("2026-11-18T20:00:00Z")), false, "22:00");
  assert.equal(smsAllowedNow("processing_done", at("2026-11-18T02:00:00Z")), false, "04:00");
  assert.equal(smsAllowedNow("processing_done", at("2026-11-18T05:00:00Z")), true, "07:00");
  assert.equal(smsAllowedNow("session_starting", at("2026-11-18T21:30:00Z")), true, "23:30, exempt");
});

// ── deliver ─────────────────────────────────────────────────────────────────

const twilio = (answer = { ok: true, status: 201, json: async () => ({ sid: "SM1" }) }) => {
  Object.assign(process.env, SMS_ENV);
  const sent = [];
  globalThis.fetch = async (_url, init) => {
    sent.push({ to: init.body.get("To"), body: init.body.get("Body") });
    return answer;
  };
  return sent;
};

test("deliver sends the SMS to a recipient whose row comes back with a number, in their language", async () => {
  const sent = twilio();
  const db = stub((text, params) => {
    if (INSERT.test(text)) {
      return { rows: [
        { user_id: 1, email: null, mail: false, locale: "en", sms_to: PHONE },
        { user_id: 2, email: null, mail: false, locale: "he", sms_to: null },
      ] };
    }
    if (/INSERT INTO sms_usage/.test(text)) return { rows: [{ id: 9 }] };
    return { rows: [], params };
  });
  await deliver([1, 2], NOTIFICATION_TYPES.SESSION_STARTING, { sessionId: 3, title: "Daf Yomi" });
  const insert = db.calls.find((c) => INSERT.test(c.text));
  assert.match(insert.text, /notification_sms_optins s WHERE s\.user_id = p\.id AND s\.category = \$4::text/);
  assert.match(insert.text, /p\.phone_verified_at IS NOT NULL/);
  assert.equal(insert.params[6], true, "a session starting may go by SMS at any hour");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, PHONE);
  assert.match(sent[0].body, /The session "Daf Yomi" has started/);
  const reserved = db.calls.find((c) => /INSERT INTO sms_usage/.test(c.text));
  assert.equal(reserved.params[1], "sessions", "recorded under its category");
});

test("a category no SMS carries does not even ask for the numbers", async () => {
  const sent = twilio();
  const db = stub((text, params) =>
    INSERT.test(text) ? { rows: params[0].map((id) => ({ user_id: id, mail: false, sms_to: null })) } : { rows: [] });
  await deliver([1], NOTIFICATION_TYPES.NEW_LESSON, { mediaId: 3 });
  assert.equal(db.calls.find((c) => INSERT.test(c.text)).params[6], false);
  assert.equal(sent.length, 0);
});

test("a number that replied STOP to the provider has its SMS turned off", async () => {
  twilio({ ok: false, status: 400, json: async () => ({ code: 21610, message: "unsubscribed" }) });
  const db = stub((text) => {
    if (INSERT.test(text)) return { rows: [{ user_id: 5, mail: false, locale: "he", sms_to: PHONE }] };
    if (/INSERT INTO sms_usage/.test(text)) return { rows: [{ id: 1 }] };
    return { rows: [] };
  });
  await deliver([5], NOTIFICATION_TYPES.PROCESSING_DONE, { mediaId: 1, title: "x" });
  const off = db.calls.find((c) => /DELETE FROM notification_sms_optins WHERE user_id = \$1$/.test(c.text));
  assert.deepEqual(off?.params, [5]);
});

// ── Preferences by channel ──────────────────────────────────────────────────

const session = (role, id = 7) => {
  const row = { id, email: "u@example.com", role };
  return { row, cookie: `token=${jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
};
const AUTH = /FROM users WHERE id=\$1 AND is_active=TRUE/;

test("SMS cannot be turned on without a verified number", async () => {
  const { row, cookie } = session("student");
  const db = stub((text) => {
    if (AUTH.test(text)) return { rows: [row] };
    if (/WITH verified AS/.test(text)) return { rows: [{ verified: 0 }] };
    return { rows: [] };
  });
  const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "sessions", sms: true });
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "PHONE_NOT_VERIFIED");
  // The number is asked in the very statement that inserts — under a share lock
  // on the user's row, so a number removed at that moment cannot leave choices.
  const statement = db.calls.find((c) => /INSERT INTO notification_sms_optins/.test(c.text)).text;
  assert.match(statement, /WITH verified AS \(\s*SELECT id FROM users\s+WHERE id = \$1 AND is_active = TRUE AND phone_verified_at IS NOT NULL\s+FOR SHARE/);
  assert.match(statement, /SELECT v\.id, c FROM verified v CROSS JOIN unnest/);
});

test("with a verified number, SMS is turned on for the caller's category", async () => {
  const { row, cookie } = session("student");
  const db = stub((text) => {
    if (AUTH.test(text)) return { rows: [row] };
    if (/WITH verified AS/.test(text)) return { rows: [{ verified: 1 }] };
    return { rows: [] };
  });
  const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "sessions", sms: true, userId: 99 });
  assert.equal(res.status, 204);
  const insert = db.calls.find((c) => /INSERT INTO notification_sms_optins/.test(c.text));
  assert.deepEqual(insert.params, [7, ["sessions"]]);
});

test("'all' off removes every SMS choice — even one made under a role the user no longer has", async () => {
  const { row, cookie } = session("student");
  const db = stub((text) => (AUTH.test(text) ? { rows: [row] } : { rows: [] }));
  const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "all", sms: false });
  assert.equal(res.status, 204);
  const del = db.calls.find((c) => /DELETE FROM notification_sms_optins/.test(c.text));
  assert.match(del.text, /WHERE user_id = \$1$/);
  assert.deepEqual(del.params, [7]);
});

test("'all' on turns on the SMS categories the role can get — a student's, not a lecturer's", async () => {
  const { row, cookie } = session("student");
  const db = stub((text) => {
    if (AUTH.test(text)) return { rows: [row] };
    if (/WITH verified AS/.test(text)) return { rows: [{ verified: 1 }] };
    return { rows: [] };
  });
  const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "all", sms: true });
  assert.equal(res.status, 204);
  const insert = db.calls.find((c) => /INSERT INTO notification_sms_optins/.test(c.text));
  assert.deepEqual(insert.params, [7, ["sessions", "enrolments"]]);
});

test("a whole audience's SMS reads the month's cap once", async () => {
  Object.assign(process.env, SMS_ENV, { SMS_MONTHLY_CAP_USD: "100" });
  const order = [];
  globalThis.fetch = async () => { order.push("sms"); return { ok: true, status: 201, json: async () => ({}) }; };
  try {
    const db = stub((text) => {
      if (INSERT.test(text)) {
        return { rows: [1, 2, 3].map((id) => ({ user_id: id, email: null, mail: false, locale: "he", sms_to: PHONE })) };
      }
      if (/SUM\(cost_usd\)/.test(text)) return { rows: [{ spent: 1 }] };
      if (/INSERT INTO sms_usage/.test(text)) return { rows: [{ id: 1 }] };
      return { rows: [] };
    });
    await deliver([1, 2, 3], NOTIFICATION_TYPES.SESSION_STARTING, { title: "x" });
    assert.equal(order.length, 3);
    assert.equal(db.calls.filter((c) => /SUM\(cost_usd\)/.test(c.text)).length, 1);
  } finally {
    delete process.env.SMS_MONTHLY_CAP_USD;
  }
});

test("a field Twilio sends twice is signed once per value", () => {
  Object.assign(process.env, SMS_ENV, { SMS_WEBHOOK_URL: WEBHOOK });
  const fields = { Body: "STOP", MediaUrl: ["https://a", "https://b"] };
  const data = `${WEBHOOK}BodySTOPMediaUrlhttps://aMediaUrlhttps://b`;
  const signature = createHmac("sha1", SMS_ENV.TWILIO_AUTH_TOKEN).update(data).digest("base64");
  assert.equal(verifyTwilioSignature(fields, signature), true);
});

test("a category no SMS carries, or a request naming both channels or neither, is refused", async () => {
  const { row, cookie } = session("lecturer");
  stub((text) => (AUTH.test(text) ? { rows: [row] } : { rows: [] }));
  for (const body of [
    { category: "new_lessons", sms: true },
    { category: "sessions", sms: true, email: false },
    { category: "sessions" },
    { category: "sessions", sms: "yes" },
  ]) {
    const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send(body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
});

test("mail preferences still work as they did", async () => {
  const { row, cookie } = session("lecturer");
  const db = stub((text) => (AUTH.test(text) ? { rows: [row] } : { rows: [] }));
  const res = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "new_lessons", email: false });
  assert.equal(res.status, 204);
  assert.ok(db.calls.some((c) => /INSERT INTO notification_email_optouts/.test(c.text)));
});

// ── A STOP reply ────────────────────────────────────────────────────────────

const WEBHOOK = "https://api.example.com/api/sms/inbound";
const sign = (fields, url = WEBHOOK, token = SMS_ENV.TWILIO_AUTH_TOKEN) =>
  createHmac("sha1", token)
    .update(Object.keys(fields).sort().reduce((acc, k) => acc + k + fields[k], url))
    .digest("base64");

test("Twilio's signature: the URL, then each field sorted by name", () => {
  Object.assign(process.env, SMS_ENV, { SMS_WEBHOOK_URL: WEBHOOK });
  const fields = { From: PHONE, Body: "STOP", To: "+15005550006" };
  assert.equal(verifyTwilioSignature(fields, sign(fields)), true);
  assert.equal(verifyTwilioSignature({ ...fields, Body: "START" }, sign(fields)), false, "a changed field");
  assert.equal(verifyTwilioSignature(fields, sign(fields, "https://evil.example/x")), false, "another URL");
  assert.equal(verifyTwilioSignature(fields, sign(fields, WEBHOOK, "other-token")), false, "another key");
  assert.equal(verifyTwilioSignature(fields, undefined), false);
  delete process.env.SMS_WEBHOOK_URL;
  assert.equal(verifyTwilioSignature(fields, sign(fields)), false, "no webhook URL set: nothing verifies");
});

test("the replies that mean stop", () => {
  for (const word of ["STOP", "stop", " Stop. ", "הסר", "הסרה", "עצור", "unsubscribe"]) assert.equal(isStopReply(word), true, word);
  for (const word of ["hello", "stop please", "", null]) assert.equal(isStopReply(word), false, String(word));
});

test("an unsigned reply is refused before anything is read", async () => {
  Object.assign(process.env, SMS_ENV, { SMS_WEBHOOK_URL: WEBHOOK });
  const db = stub(() => ({ rows: [] }));
  const res = await request(app).post("/api/sms/inbound").type("form").send({ From: PHONE, Body: "STOP" });
  assert.equal(res.status, 403);
  assert.equal(db.calls.length, 0);
});

test("a signed STOP turns off every SMS of the account holding that number", async () => {
  Object.assign(process.env, SMS_ENV, { SMS_WEBHOOK_URL: WEBHOOK });
  const db = stub((text) => (/SELECT id FROM users WHERE phone_e164/.test(text) ? { rows: [{ id: 12 }] } : { rows: [] }));
  const fields = { From: PHONE, Body: "STOP", To: "+15005550006" };
  const res = await request(app).post("/api/sms/inbound").set("X-Twilio-Signature", sign(fields)).type("form").send(fields);
  assert.equal(res.status, 200);
  assert.match(res.type, /xml/);
  assert.deepEqual(db.calls.find((c) => /SELECT id FROM users WHERE phone_e164/.test(c.text)).params, [PHONE]);
  assert.deepEqual(db.calls.find((c) => /DELETE FROM notification_sms_optins/.test(c.text)).params, [12]);
});

test("a signed reply that is not STOP changes nothing", async () => {
  Object.assign(process.env, SMS_ENV, { SMS_WEBHOOK_URL: WEBHOOK });
  const db = stub(() => ({ rows: [] }));
  const fields = { From: PHONE, Body: "תודה" };
  const res = await request(app).post("/api/sms/inbound").set("X-Twilio-Signature", sign(fields)).type("form").send(fields);
  assert.equal(res.status, 200);
  assert.equal(db.calls.length, 0);
});
