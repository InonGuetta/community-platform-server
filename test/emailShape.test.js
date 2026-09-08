import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { emailProblem } from "../lib/validate.js";

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
  const problem = emailProblem("userexample.com");
  assert.ok(problem);
  assert.match(problem, /@/, "the message names what is missing");
});

test("two @ are refused", () => {
  assert.ok(emailProblem("user@@example.com"));
  assert.ok(emailProblem("user@a@example.com"));
});

// The most common real mistake by a wide margin: the sender simply stopped.
test("a domain with no dot is refused", () => {
  const problem = emailProblem("user@gmail");
  assert.ok(problem);
  assert.match(problem, /סיומת/, "the message says a suffix is missing");
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

// "כתובת אימייל אינה תקינה" on a missing dot is a message that makes somebody
// retype a correct address several times.
test("every refusal explains itself in Hebrew", () => {
  for (const email of ["userexample.com", "user@gmail", "user name@x.com", "user@example.c"]) {
    const problem = emailProblem(email);
    assert.ok(problem);
    assert.match(problem, /[֐-׿]/, `"${email}" produced a message with no Hebrew in it`);
    assert.notEqual(problem, "כתובת אימייל אינה תקינה", "a generic message helps nobody");
  }
});
