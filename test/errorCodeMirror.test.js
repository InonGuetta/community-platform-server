import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { ERROR_CODES } from "../lib/AppError.js";

// The two repositories' ERROR_CODES lists, checked against each other.
//
// This pair is the application's most-warned-about hazard and the one with the
// least to catch it: AppError.js says "edit both together", apiError.js says the
// same back, and until now nothing verified it. The failure is silent by
// construction — a code present on only one side raises nothing anywhere, the
// Hebrew lookup simply misses and the user drops to the generic message. That
// has already happened twice, which is why both files carry the warning.
//
// Read as TEXT rather than imported, because the client is a separate npm
// package with its own module graph and importing across the boundary would pull
// its dependencies into this suite. The list is a plain object literal, so
// scraping the keys is stable enough — and if the shape ever changes, the count
// assertion below fails loudly rather than passing vacuously.
const CLIENT_API_ERROR = new URL(
  "../../community-platform-client/src/utilities/apiError.js",
  import.meta.url
);

const clientCodes = async () => {
  const source = await readFile(CLIENT_API_ERROR, "utf8");
  const list = source.slice(source.indexOf("export const ERROR_CODES"), source.indexOf("};"));
  return new Set([...list.matchAll(/^\s{2}([A-Z_]+):\s*"([^"]+)"/gm)].map((m) => m[2]));
};

test("the client's mirror was actually found and parsed", async () => {
  // Guards every assertion below: a moved file or a reshaped literal would
  // otherwise make this whole file pass while comparing nothing.
  const codes = await clientCodes();
  assert.ok(codes.size > 20, `expected the client's full list, parsed ${codes.size}`);
});

test("every server error code exists on the client", async () => {
  const client = await clientCodes();
  const missing = Object.values(ERROR_CODES).filter((code) => !client.has(code));
  assert.deepEqual(
    missing, [],
    "these codes are thrown by the server and unknown to the client, so they fall " +
    "back to the generic Hebrew message — add them to the client's apiError.js"
  );
});

// The other direction matters too, though it fails more gently: a client entry
// for a code the server never sends is dead Hebrew, and usually the fossil of a
// code that was renamed on one side only — which the rule "a code is never
// renamed or reused" exists to prevent.
//
// The client-only group is excluded by name: axiosInstance stamps those on
// failures the server was never reached for, so they are expected to be absent
// here.
const CLIENT_ONLY = new Set([
  "API_UNAVAILABLE",
  "NETWORK_UNREACHABLE",
  "SERVER_UNAVAILABLE",
  "BAD_RESPONSE",
]);

test("the client knows no server codes the server cannot send", async () => {
  const server = new Set(Object.values(ERROR_CODES));
  const orphans = [...(await clientCodes())].filter(
    (code) => !server.has(code) && !CLIENT_ONLY.has(code)
  );
  assert.deepEqual(
    orphans, [],
    "these are known to the client but no longer thrown by the server — either a " +
    "rename that only landed on one side, or Hebrew for a case that no longer exists"
  );
});
