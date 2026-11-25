import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { issueVerificationForUser, TOKEN_PURPOSE } from "../services/servicesAuth.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// POST /api/auth/resend-verification (UI_UX_FIXES 3.12 / stage 5): the
// verification link again, for the signed-in user whose address is not yet
// verified — sign-up's own token (password_resets, purpose "verify"), mailed
// the way sign-up mails it. No new token scheme.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const USER = { id: 12, email: "reader@example.com", role: "student" };
const cookieFor = (user) =>
  `token=${jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

// ── The service ─────────────────────────────────────────────────────────────

test("an unverified account gets a fresh sign-up token, stored as a hash, with its address and language", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM users/.test(text) ? { rows: [{ email: USER.email, locale: "fr", email_verified: false }] } : { rows: [] });
  try {
    const result = await issueVerificationForUser(USER.id);
    assert.equal(result.alreadyVerified, false);
    assert.equal(result.email, USER.email);
    assert.equal(result.locale, "fr");
    assert.match(result.token, /^[0-9a-f]{64}$/);
    const insert = stub.calls.find((c) => /INSERT INTO password_resets/.test(c.text));
    assert.ok(insert, "a token row was written");
    assert.equal(insert.params[0], USER.id);
    assert.equal(insert.params[3], TOKEN_PURPOSE.VERIFY, "a verification token, never a reset one");
    assert.ok(!insert.params.includes(result.token), "only the hash is stored");
    // Only an active account is asked about.
    assert.match(stub.calls[0].text, /is_active = TRUE/);
  } finally {
    stub.restore();
  }
});

test("a verified account is told so, and no token is made", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM users/.test(text) ? { rows: [{ email: USER.email, locale: "he", email_verified: true }] } : { rows: [] });
  try {
    assert.deepEqual(await issueVerificationForUser(USER.id), { alreadyVerified: true });
    assert.equal(stub.calls.some((c) => /INSERT INTO password_resets/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("an account that is gone is a 404", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await assert.rejects(issueVerificationForUser(USER.id), { statusCode: 404 });
  } finally {
    stub.restore();
  }
});

// ── The route ───────────────────────────────────────────────────────────────

// verifyToken's lookup, then the service's — both are "FROM users".
const signedIn = (verified) =>
  stubPoolQuery(pool, (text) => {
    if (/INSERT INTO password_resets/.test(text)) return { rows: [] };
    if (/email_verified FROM users/.test(text)) return { rows: [{ email: USER.email, locale: "he", email_verified: verified }] };
    return { rows: [USER] };
  });

test("anonymous is a 401", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).post("/api/auth/resend-verification");
    assert.equal(res.status, 401);
  } finally {
    stub.restore();
  }
});

test("the signed-in user's own address: a token is issued and the answer says whether the mail went", async () => {
  const stub = signedIn(false);
  try {
    // Takes nothing from the body: the address is the session's, so asking
    // for somebody else's is not something this door can be told to do.
    const res = await request(app)
      .post("/api/auth/resend-verification")
      .set("Cookie", cookieFor(USER))
      .send({ email: "someone-else@example.com", userId: 99 });
    assert.equal(res.status, 200);
    // No SMTP in the suite, so mailer logs the message instead and reports it
    // was not sent — which the answer says truthfully.
    assert.deepEqual(res.body, { sent: false, alreadyVerified: false });
    const insert = stub.calls.find((c) => /INSERT INTO password_resets/.test(c.text));
    assert.equal(insert.params[0], USER.id);
  } finally {
    stub.restore();
  }
});

test("an address already verified answers so, with no token and no mail", async () => {
  const stub = signedIn(true);
  try {
    const res = await request(app).post("/api/auth/resend-verification").set("Cookie", cookieFor(USER));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { sent: false, alreadyVerified: true });
    assert.equal(stub.calls.some((c) => /INSERT INTO password_resets/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("rate limited per account: five an hour, then a 429", async () => {
  const other = { ...USER, id: 13 };
  const stub = stubPoolQuery(pool, (text) => {
    if (/INSERT INTO password_resets/.test(text)) return { rows: [] };
    if (/email_verified FROM users/.test(text)) return { rows: [{ email: other.email, locale: "he", email_verified: false }] };
    return { rows: [other] };
  });
  try {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      statuses.push((await request(app).post("/api/auth/resend-verification").set("Cookie", cookieFor(other))).status);
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  } finally {
    stub.restore();
  }
});
