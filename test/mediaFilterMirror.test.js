import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";

// The archive filter's query parameters, checked against the names the client
// actually sends.
//
// This is the fourth pair that crosses the repository boundary, and it fails the
// same silent way the other three do: the client puts `excludedTagIds` in the
// query string, the server reads `excludeTagIds`, and nothing anywhere raises.
// The request succeeds, the status is 200, and the archive simply comes back
// unfiltered — which reads as "the filter does nothing" and sends somebody
// looking through the SQL for a bug that is a missing letter in another
// repository.
//
// Checked in ONE direction on purpose: every parameter the client sends must be
// one the server reads. The reverse would be wrong to assert — the server
// legitimately accepts parameters no screen sends yet (`published` and
// `courseId` are read only by privileged callers and by the course page), and a
// parameter added here before the UI that uses it is a normal order of work.
//
// Both sides are read as TEXT. The client is a separate npm package with its own
// module graph, and importing across the boundary would pull its dependencies
// into this suite — the same reason errorCodeMirror and socketEventMirror scrape
// rather than import.

const CLIENT_ARCHIVE_CONTROLLER = new URL(
  "../../community-platform-client/src/components/pages/archive/useArchivePageController.js",
  import.meta.url
);
const SERVER_MEDIA_CONTROLLER = new URL("../controllers/controllersMedia.js", import.meta.url);

// What the client puts into the listing request: the object literal handed to
// fetchAllMedia, whose keys become the query string verbatim (mediaApi passes it
// straight to axios as `params`).
const clientParams = async () => {
  const source = await readFile(CLIENT_ARCHIVE_CONTROLLER, "utf8");
  const call = source.slice(source.indexOf("fetchAllMedia({"));
  // Brace-matched rather than cut at the first "})", because every line in the
  // payload is itself a `{ ... }` — cutting at the first one found exactly one
  // parameter and would have made this file pass while checking almost nothing.
  const open = call.indexOf("{");
  let depth = 0;
  let close = open;
  for (let i = open; i < call.length; i += 1) {
    if (call[i] === "{") depth += 1;
    if (call[i] === "}") depth -= 1;
    if (depth === 0) {
      close = i;
      break;
    }
  }
  const block = call.slice(open, close);
  // Each line is either `...(cond && { name: value })` or a bare `{ name }`, so
  // the key is what follows the brace.
  return new Set([...block.matchAll(/\{\s*([A-Za-z][A-Za-z0-9]*)\s*[,:}]/g)].map((m) => m[1]));
};

// What the server reads off req.query in the listing handler.
const serverParams = async () => {
  const source = await readFile(SERVER_MEDIA_CONTROLLER, "utf8");
  const handler = source.slice(source.indexOf("export const getAllMedia"));
  // The destructuring itself, not the function body's brace — anchored on
  // req.query so that reformatting the line (it has already outgrown one) does
  // not quietly turn this into a comparison against nothing.
  const [, destructuring = ""] = handler.match(/const\s*\{([^}]*)\}\s*=\s*\s*req\.query/) || [];
  return new Set(destructuring.split(",").map((name) => name.trim()).filter(Boolean));
};

test("both sides were actually found and parsed", async () => {
  // Guards every assertion below: a moved file, a renamed thunk or a reshaped
  // literal would otherwise let this file pass while comparing two empty sets.
  const client = await clientParams();
  const server = await serverParams();
  assert.ok(client.size >= 5, `expected the client's filter payload, parsed ${client.size}`);
  assert.ok(server.size >= 6, `expected the server's query fields, parsed ${server.size}`);
  assert.ok(client.has("tagIds"), "the tag filter is the pair this exists for");
  assert.ok(server.has("tagIds"), "the tag filter is the pair this exists for");
});

test("every filter the client sends is one the server reads", async () => {
  const client = await clientParams();
  const server = await serverParams();
  const unread = [...client].filter((name) => !server.has(name));
  assert.deepEqual(
    unread,
    [],
    `the client sends ${unread.join(", ")}, which the archive listing ignores — a filter that silently does nothing`
  );
});

// Named explicitly rather than left to the loop above, because this one is new
// on the server and arrives on the client separately: until it does, the loop
// passes vacuously for it and this test says why.
test("the exclusion list is spelled the same on both sides, once the client sends it", async () => {
  const client = await clientParams();
  const server = await serverParams();
  assert.ok(server.has("excludeTagIds"), "the server reads the exclusion list");
  const clientNames = [...client];
  const nearMisses = clientNames.filter(
    (name) => /exclude/i.test(name) && name !== "excludeTagIds"
  );
  assert.deepEqual(nearMisses, [], `the client spells it ${nearMisses.join(", ")}`);
});
