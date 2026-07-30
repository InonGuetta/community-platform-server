import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { requireSeconds, optionalSeconds, optionalId, optionalBoolean } from "../lib/validate.js";

const rejects = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err.statusCode === 400;
  }
};

test("requireSeconds accepts real positions", () => {
  assert.equal(requireSeconds(0, "x"), 0);
  assert.equal(requireSeconds(12.9, "x"), 12, "fractional seconds floor");
  assert.equal(requireSeconds("42", "x"), 42, "form data arrives as strings");
});

test("requireSeconds rejects anything that is not a position", () => {
  for (const bad of ["abc", -1, undefined, NaN, Infinity, ""]) {
    assert.ok(rejects(() => requireSeconds(bad, "x")), `${String(bad)} should be a 400`);
  }
});

// Number(null) is 0, so without an explicit guard a missing position silently
// saved as "back to the start" and wiped the viewer's place in a lecture.
test("requireSeconds rejects null rather than reading it as zero", () => {
  assert.ok(rejects(() => requireSeconds(null, "positionSeconds")));
});

test("optionalSeconds distinguishes absent from zero", () => {
  assert.equal(optionalSeconds(undefined, "x"), null);
  assert.equal(optionalSeconds(null, "x"), null);
  assert.equal(optionalSeconds(0, "x"), 0, "zero is a real timestamp, not 'absent'");
  assert.ok(rejects(() => optionalSeconds("bad", "x")));
});

test("optionalId only accepts positive integers", () => {
  assert.equal(optionalId(undefined, "x"), null);
  assert.equal(optionalId("7", "x"), 7);
  for (const bad of [0, -3, 1.5, "abc"]) {
    assert.ok(rejects(() => optionalId(bad, "x")), `${String(bad)} should be a 400`);
  }
});

test("optionalBoolean does not coerce", () => {
  assert.equal(optionalBoolean(undefined, "x"), null, "absent leaves the column alone");
  assert.equal(optionalBoolean(false, "x"), false, "false is a value, not an absence");
  assert.ok(rejects(() => optionalBoolean("true", "x")), "a string is not a boolean");
});
