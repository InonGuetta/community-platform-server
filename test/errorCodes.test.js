import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, notFound, badRequest, unauthorized, forbidden, conflict } from "../lib/AppError.js";
import { requireRole } from "../middleware/requireRole.js";
import { verifyToken } from "../middleware/auth.js";

// `code` is the half of the error contract the client holds. It picks the Hebrew
// the user sees, keyed on the code and no longer on the English message — which
// was matched character for character and broke silently the first time a
// message was reworded. These guard the properties that promise makes.

test("no two codes share a value, or one translation would shadow another", () => {
  const values = Object.values(ERROR_CODES);
  assert.equal(values.length, new Set(values).size);
});

// Renaming a code is the one edit that breaks the other repository with nothing
// failing here. Pinning the strings makes that edit deliberate: this test has to
// be changed in the same commit, which is the prompt to change the client too.
test("the codes the client translates are pinned to their exact strings", () => {
  assert.deepEqual(
    {
      EMAIL_TAKEN: ERROR_CODES.EMAIL_TAKEN,
      UNAUTHORIZED: ERROR_CODES.UNAUTHORIZED,
      INVALID_TOKEN: ERROR_CODES.INVALID_TOKEN,
      FORBIDDEN: ERROR_CODES.FORBIDDEN,
      MEDIA_NOT_FOUND: ERROR_CODES.MEDIA_NOT_FOUND,
      TRANSCRIPT_NOT_FOUND: ERROR_CODES.TRANSCRIPT_NOT_FOUND,
      DB_UNAVAILABLE: ERROR_CODES.DB_UNAVAILABLE,
      INTERNAL: ERROR_CODES.INTERNAL,
    },
    {
      EMAIL_TAKEN: "EMAIL_TAKEN",
      UNAUTHORIZED: "UNAUTHORIZED",
      INVALID_TOKEN: "INVALID_TOKEN",
      FORBIDDEN: "FORBIDDEN",
      MEDIA_NOT_FOUND: "MEDIA_NOT_FOUND",
      TRANSCRIPT_NOT_FOUND: "TRANSCRIPT_NOT_FOUND",
      DB_UNAVAILABLE: "DB_UNAVAILABLE",
      INTERNAL: "INTERNAL_ERROR",
    }
  );
});

test("every AppError helper carries a code without being asked", () => {
  for (const [make, expected] of [
    [notFound, ERROR_CODES.NOT_FOUND],
    [badRequest, ERROR_CODES.BAD_REQUEST],
    [unauthorized, ERROR_CODES.UNAUTHORIZED],
    [forbidden, ERROR_CODES.FORBIDDEN],
  ]) {
    assert.equal(make("msg").code, expected);
  }
  assert.equal(conflict("msg").code, ERROR_CODES.CONFLICT);
});

test("a specific code overrides the generic default", () => {
  assert.equal(conflict("Email already in use", ERROR_CODES.EMAIL_TAKEN).code, "EMAIL_TAKEN");
});

// These two answer directly rather than throwing an AppError, so they bypass the
// error handler that would otherwise attach the code — which is exactly why they
// were the two places the client could not tell "not signed in" from "not
// allowed" without reading the prose.
const capture = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

test("requireRole answers 403 with FORBIDDEN", () => {
  const res = capture();
  let nexted = false;
  requireRole("admin")({ user: { role: "student" } }, res, () => { nexted = true; });

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, ERROR_CODES.FORBIDDEN);
  assert.equal(nexted, false);
});

test("requireRole lets an allowed role through untouched", () => {
  const res = capture();
  let nexted = false;
  requireRole("admin", "lecturer")({ user: { role: "lecturer" } }, res, () => { nexted = true; });

  assert.equal(nexted, true);
  assert.equal(res.statusCode, null);
});

test("verifyToken distinguishes a missing cookie from a bad one, by code", async () => {
  const missing = capture();
  await verifyToken({ cookies: {} }, missing, () => {});
  assert.equal(missing.statusCode, 401);
  assert.equal(missing.body.code, ERROR_CODES.UNAUTHORIZED);

  const bad = capture();
  await verifyToken({ cookies: { token: "not-a-jwt" } }, bad, () => {});
  assert.equal(bad.statusCode, 401);
  assert.equal(bad.body.code, ERROR_CODES.INVALID_TOKEN);
});
