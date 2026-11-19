import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RESEND_AFTER_SECONDS, CODE_TTL_MINUTES } from "../services/servicesPhone.js";

// The phone code's timing, on both sides of the repository boundary (PRD
// AUTH-13): the server decides when another code may be sent and how long one
// lasts (services/servicesPhone.js); the client times its "new code in N
// seconds" from the same two numbers (utilities/phone.js), and derives when a
// waiting code was sent from its expiry. Read as text — the client is another
// npm package.

const here = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.resolve(here, "../../community-platform-client/src/utilities/phone.js");

const clientConstant = (source, name) => {
  const match = new RegExp(`export const ${name} = (\\d+);`).exec(source);
  return match ? Number(match[1]) : null;
};

test("the client's code timing is the server's", { skip: !fs.existsSync(CLIENT_FILE) && "client not checked out beside the server" }, () => {
  const source = fs.readFileSync(CLIENT_FILE, "utf8");
  const resend = clientConstant(source, "RESEND_AFTER_SECONDS");
  const ttl = clientConstant(source, "CODE_TTL_MINUTES");
  // The parse found something: a moved file must not pass by comparing nothing.
  assert.ok(resend !== null && ttl !== null, "both constants found in the client's utilities/phone.js");
  assert.equal(resend, RESEND_AFTER_SECONDS);
  assert.equal(ttl, CODE_TTL_MINUTES);
});
