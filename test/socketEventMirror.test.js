import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { SOCKET_EVENTS } from "../sockets/socketEvents.js";

// The socket protocol, checked against the client's copy of it.
//
// Both files say "edit both together" and neither could enforce it. The failure
// is the quietest one in this application: a name present on only one side
// raises nothing anywhere — socket.io simply registers a listener that never
// fires, or emits into the void — and the symptom is a room that connects and
// then does nothing, with no stack trace to follow.
//
// The client is a separate npm package with its own module graph, so its copy is
// read as text rather than imported.
const CLIENT_EVENTS = new URL(
  "../../community-platform-client/src/utilities/socketEvents.js",
  import.meta.url
);

const clientEvents = async () => {
  const source = await readFile(CLIENT_EVENTS, "utf8");
  const block = source.slice(source.indexOf("export const SOCKET_EVENTS"), source.indexOf("};"));
  return Object.fromEntries(
    [...block.matchAll(/^\s{2}([A-Z_]+):\s*"([^"]+)"/gm)].map((m) => [m[1], m[2]])
  );
};

test("the client's copy was actually found and parsed", async () => {
  // Guards the assertions below: a moved file or a reshaped literal would
  // otherwise let this whole file pass while comparing nothing.
  const events = await clientEvents();
  assert.ok(Object.keys(events).length > 8, `expected the full protocol, parsed ${Object.keys(events).length}`);
});

test("both sides name the same events", async () => {
  const client = await clientEvents();
  const serverNames = Object.keys(SOCKET_EVENTS).sort();
  assert.deepEqual(
    Object.keys(client).sort(), serverNames,
    "sockets/socketEvents.js and the client's utilities/socketEvents.js must list the same events"
  );
});

// The names matching is not enough — the wire strings are what actually have to
// agree, and a typo in one of them is precisely the drift that produces a
// listener nothing ever fires.
test("both sides agree on every wire string", async () => {
  const client = await clientEvents();
  const disagreements = Object.entries(SOCKET_EVENTS)
    .filter(([name, value]) => client[name] !== value)
    .map(([name, value]) => `${name}: server "${value}" vs client "${client[name]}"`);

  assert.deepEqual(disagreements, [], "the two copies describe different protocols");
});
