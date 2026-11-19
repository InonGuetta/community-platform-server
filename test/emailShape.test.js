import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { emailProblem, assertUsableEmail } from "../lib/validate.js";

// Is this SHAPED like an address?
//
// It cannot check that the inbox exists — only the verification mail does that.
// What it catches is the typo, at the moment it is made, rather than three days
// later when somebody wonders why nothing arrived.
//
// The two groups below are not equally important. Rejecting a valid address
// locks somebody out of signing up with no way around it; accepting a subtly
// invalid one costs one bounced message. So the "must be accepted" group is the
// one that must never regress.

// ── Addresses that must be accepted ─────────────────────────────────────────

test("ordinary addresses pass", () => {
  for (const email of [
    "user@example.com",
    "first.last@example.com",
    "user+tag@example.com",
    "user_name@example.co.il",
    "user-name@sub.domain.example.org",
    "u@a.co",
    "1234@example.com",
    "USER@EXAMPLE.COM",
    "  spaced@example.com  ", // trimmed before checking
  ]) {
    assert.equal(emailProblem(email), null, `${email} should be accepted`);
  }
});

// A Hebrew-speaking user may legitimately have one, and refusing it would be
// exactly the lockout this is written to avoid.
test("a Hebrew local part is accepted", () => {
  assert.equal(emailProblem("ישראל@example.com"), null);
});

test("an internationalised domain is accepted", () => {
  assert.equal(emailProblem("user@דואר.example"), null);
});

test("a long but legal address is accepted", () => {
  assert.equal(emailProblem(`${"a".repeat(64)}@example.com`), null);
});

// ── Addresses that must be refused ──────────────────────────────────────────

test("a missing @ is refused, and said so", () => {
  assert.equal(emailProblem("userexample.com"), "noAt", "the reason names what is missing");
});

test("two @ are refused", () => {
  assert.ok(emailProblem("user@@example.com"));
  assert.ok(emailProblem("user@a@example.com"));
});

// The most common real mistake by a wide margin: the sender simply stopped.
test("a domain with no dot is refused", () => {
  assert.equal(emailProblem("user@gmail"), "noSuffix", "the reason says a suffix is missing");
});

test("a missing local part or domain is refused", () => {
  assert.ok(emailProblem("@example.com"));
  assert.ok(emailProblem("user@"));
});

test("whitespace anywhere inside is refused", () => {
  assert.ok(emailProblem("user name@example.com"));
  assert.ok(emailProblem("user@exa mple.com"));
});

test("stray dots are refused", () => {
  assert.ok(emailProblem(".user@example.com"));
  assert.ok(emailProblem("user.@example.com"));
  assert.ok(emailProblem("user..name@example.com"));
  assert.ok(emailProblem("user@example..com"));
  assert.ok(emailProblem("user@.example.com"));
  assert.ok(emailProblem("user@example.com."));
});

test("a one-letter or numeric suffix is refused", () => {
  assert.ok(emailProblem("user@example.c"));
  assert.ok(emailProblem("user@example.123"));
});

test("a hyphen at the edge of a domain label is refused", () => {
  assert.ok(emailProblem("user@-example.com"));
  assert.ok(emailProblem("user@example-.com"));
});

test("nothing at all is refused", () => {
  for (const value of ["", "   ", null, undefined, 42, {}]) {
    assert.ok(emailProblem(value), `${JSON.stringify(value)} should be refused`);
  }
});

test("an address longer than an SMTP envelope accepts is refused", () => {
  assert.ok(emailProblem(`${"a".repeat(250)}@example.com`));
});

test("a local part over 64 characters is refused", () => {
  assert.ok(emailProblem(`${"a".repeat(65)}@example.com`));
});

// ── The message, not just the verdict ───────────────────────────────────────

// "Invalid address" on a missing dot is a message that makes somebody retype a
// correct address several times. The reason is a key the client words as
// auth:emailShape.<key> — so every key this file can return must exist there,
// or the client shows nothing at all for it. The client is a separate package,
// read as text (like the other mirror tests).
const CLIENT_AUTH = new URL("../../community-platform-client/src/locales/he/auth.json", import.meta.url);

test("every reason is a key the client can word", () => {
  const worded = Object.keys(JSON.parse(readFileSync(CLIENT_AUTH, "utf8")).emailShape ?? {});
  assert.ok(worded.length > 10, "the client's emailShape keys were not found");

  const source = readFileSync(new URL("../lib/validate.js", import.meta.url), "utf8");
  const body = source.slice(source.indexOf("export const emailProblem"), source.indexOf("export const assertUsableEmail"));
  const returned = [...body.matchAll(/return "([A-Za-z]+)"/g)].map((m) => m[1]);
  assert.ok(returned.length > 10, "emailProblem's reasons were not found");
  for (const key of returned) assert.ok(worded.includes(key), `auth:emailShape.${key} is missing on the client`);

  for (const email of ["userexample.com", "user@gmail", "user name@x.com", "user@example.c"]) {
    assert.ok(worded.includes(emailProblem(email)), email);
  }
});

test("the 400 carries the reason as a code and a param, not a sentence", () => {
  assert.throws(
    () => assertUsableEmail("user@gmail"),
    (err) => err.statusCode === 400 && err.code === "INVALID_EMAIL" && err.params.reason === "noSuffix"
  );
});
