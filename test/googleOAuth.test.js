import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { googleOAuthLogin } from "../services/servicesAuth.js";

// The second way into the application, which for a long time enforced less than
// the first one did.

const profile = ({ verified = true, email = "a@example.com", id = "google-123" } = {}) => ({
  id,
  displayName: "אברהם",
  emails: [{ value: email }],
  photos: [{ value: "https://example.com/a.png" }],
  _json: { email_verified: verified },
});

// A factory, not a shared constant, and the difference bit once already: on the
// linking path googleOAuthLogin assigns google_id onto the row object it read, so
// a fixture handed out by reference carries that mutation into the next test and
// the account arrives already linked. Harmless in production, where every query
// builds a fresh row — but it silently turned the unverified-email assertion
// below into a test of the already-linked path instead.
const passwordAccount = (over = {}) => ({
  id: 4,
  email: "a@example.com",
  role: "student",
  password_hash: "$2a$12$hash",
  google_id: null,
  is_active: true,
  ...over,
});

// login() has filtered on is_active in its WHERE clause from the start. This path
// had no equivalent, so a closed account was handed a fresh seven-day cookie and
// then refused by verifyToken on every request after — which reads as a broken
// application rather than a closed account.
test("a deactivated account cannot sign in with Google", async () => {
  const stub = stubPoolQuery(pool, () => ({
    rows: [passwordAccount({ google_id: "google-123", is_active: false })],
  }));
  try {
    await assert.rejects(() => googleOAuthLogin(profile()), { statusCode: 401 });
  } finally {
    stub.restore();
  }
});

// The refusal must not be expressed by filtering the row out of the SELECT: with
// no row found, the function falls through to its INSERT and the still-present
// email trips the unique index, turning a refusal into a 500.
test("the refusal happens without falling through to the insert", async () => {
  const stub = stubPoolQuery(pool, () => ({
    rows: [passwordAccount({ google_id: "google-123", is_active: false })],
  }));
  try {
    await googleOAuthLogin(profile()).catch(() => {});
    assert.equal(
      stub.calls.some((c) => /INSERT INTO users/i.test(c.text)),
      false,
      "a deactivated user must never be re-created as a new account"
    );
  } finally {
    stub.restore();
  }
});

// Linking a Google identity to an account that already has a PASSWORD is decided
// purely on a matching email address. If Google has not verified that address,
// the match proves nothing about who is signing in.
test("an unverified email cannot be linked to an existing password account", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passwordAccount()] }));
  try {
    await assert.rejects(() => googleOAuthLogin(profile({ verified: false })), { statusCode: 401 });
    assert.equal(
      stub.calls.some((c) => /UPDATE users SET\s+google_id/i.test(c.text)),
      false,
      "the account must not be linked"
    );
  } finally {
    stub.restore();
  }
});

test("a verified email links to the existing account", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passwordAccount()] }));
  try {
    const user = await googleOAuthLogin(profile({ verified: true }));
    assert.equal(user.id, 4);
    assert.equal(user.password_hash, undefined, "the hash must never leave the service");
    assert.ok(stub.calls.some((c) => /UPDATE users SET\s+google_id/i.test(c.text)));
  } finally {
    stub.restore();
  }
});

// A profile shape the library does not give us today must not be read as
// "verified" — a future version changing the field would otherwise reopen this
// silently.
test("a profile with no verification claim counts as unverified", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passwordAccount()] }));
  try {
    const bare = { id: "google-123", displayName: "x", emails: [{ value: "a@example.com" }] };
    await assert.rejects(() => googleOAuthLogin(bare), { statusCode: 401 });
  } finally {
    stub.restore();
  }
});

// The account existed with a password, and nobody ever proved the address
// belonged to whoever set it. Google now has. That password is the loose end —
// it was chosen by whoever typed the address into the registration form, which
// need not be the person signing in — so linking clears it rather than leaving a
// second, unproven way into an account its rightful owner has just claimed.
test("linking supersedes a password on an account whose email was never verified", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passwordAccount({ email_verified: false })] }));
  try {
    await googleOAuthLogin(profile({ verified: true }));
    const update = stub.calls.find((c) => /UPDATE users SET\s+google_id/i.test(c.text));
    assert.ok(update, "the link should still happen");
    assert.equal(update.params[3], true, "the unproven password must be cleared");
    assert.match(update.text, /password_changed_at/, "and the sessions it opened ended with it");
  } finally {
    stub.restore();
  }
});

test("a verified account keeps its password when a Google identity is linked", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [passwordAccount({ email_verified: true })] }));
  try {
    await googleOAuthLogin(profile({ verified: true }));
    const update = stub.calls.find((c) => /UPDATE users SET\s+google_id/i.test(c.text));
    assert.equal(update.params[3], false, "a proven password is not a loose end");
  } finally {
    stub.restore();
  }
});

// Matching on google_id means this identity has signed in here before, so there
// is no account being claimed and nothing for the email check to protect.
test("an account already linked by google_id does not re-check the email", async () => {
  const linked = passwordAccount({ google_id: "google-123" });
  const stub = stubPoolQuery(pool, () => ({ rows: [linked] }));
  try {
    const user = await googleOAuthLogin(profile({ verified: false }));
    assert.equal(user.id, 4);
  } finally {
    stub.restore();
  }
});
