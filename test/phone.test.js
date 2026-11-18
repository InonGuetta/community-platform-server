import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readPhone, maskPhone, phoneHash } from "../lib/phone.js";
import { requirePhone } from "../lib/validate.js";

// A mobile number as the platform holds it (lib/phone.js, migration 054).

test("however it is typed, an Israeli mobile becomes one E.164 number", () => {
  for (const typed of ["054-5551234", "0545551234", "054 555 1234", "+972 54 555 1234", "+972545551234", " 054-555-1234 "]) {
    assert.deepEqual(readPhone(typed), { e164: "+972545551234" }, typed);
  }
});

test("a number with its own country code keeps it", () => {
  assert.deepEqual(readPhone("+1 212 555 0199"), { e164: "+12125550199" });
});

test("a landline is told apart from a number that is not one at all", () => {
  assert.deepEqual(readPhone("02-6234567"), { problem: "notMobile" });
  for (const bad of ["12345", "", "   ", null, 5, "abc", "0".repeat(50)]) {
    assert.deepEqual(readPhone(bad), { problem: "invalid" }, String(bad));
  }
});

test("the guard answers with the code that says what to fix", () => {
  assert.equal(requirePhone("054-5551234"), "+972545551234");
  assert.throws(() => requirePhone("02-6234567"), (e) => e.code === "PHONE_NOT_MOBILE" && e.statusCode === 400);
  assert.throws(() => requirePhone("123"), (e) => e.code === "PHONE_INVALID");
});

test("a number is shown masked and counted by its hash, never stored or logged whole", () => {
  assert.equal(maskPhone("+972545551234"), "+972•••••1234");
  assert.equal(maskPhone(null), null);
  assert.match(phoneHash("+972545551234"), /^[0-9a-f]{64}$/);
  assert.notEqual(phoneHash("+972545551234"), phoneHash("+972545551235"));
});
