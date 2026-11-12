import "./setup.js";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { initSockets } from "../sockets/socketManager.js";
import { SOCKET_EVENTS } from "../sockets/socketEvents.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Ending a live session, by either door: DELETE /api/sessions/:id/end, or the
// host's END_SESSION over the socket. Whichever door, the row is ended in one
// UPDATE whose WHERE is the host check, and then the same two things follow, in
// this order: the room is told SESSION_ENDED and emptied, and any recording
// still open is joined from what reached the server.
//
// The socket side is driven through the real initSockets, with a stand-in
// socket handed to its connection handler and the server's own room calls
// (io.to / io.in) observed — the same trade socketAuth.test.js makes: the rule
// is under test, not socket.io.

const httpServer = http.createServer();
await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
const io = initSockets(httpServer);
const app = createApp();

after(async () => {
  await new Promise((resolve) => io.close(() => resolve()));
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const HOST = { id: 10, email: "h@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "o@example.com", role: "lecturer", is_active: true };
const cookieFor = (user) =>
  `token=${jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const SESSION = { id: 4, host_id: 10, title: "שיעור חי", room_token: "room-abc", recording_s3_key: null, is_active: false };

// What happened, in order: the statements sent and the room operations.
const run = async ({ endedRow, existing, failUpdate = false, user = HOST }, act) => {
  const log = [];
  const db = stubPoolQuery(pool, (text, params) => {
    if (/FROM users/i.test(text)) return { rows: [user] };
    if (/UPDATE live_sessions SET is_active=FALSE/.test(text)) {
      log.push(["end", /room_token=\$1/.test(text) ? "by room" : "by id", params]);
      if (failUpdate) throw new Error("connection reset");
      return { rows: endedRow ? [endedRow] : [] };
    }
    if (/SELECT \* FROM live_sessions WHERE id=\$1/.test(text)) return { rows: existing ? [existing] : [] };
    if (/FROM session_recordings WHERE session_id=\$1 AND status='recording'/.test(text)) {
      log.push(["recordings", params[0]]);
      return { rows: [] };
    }
    return { rows: [] };
  });
  const to = mock.method(io, "to", (room) => ({ emit: (event) => log.push(["tell", room, event]) }));
  const into = mock.method(io, "in", (room) => ({ socketsLeave: (left) => log.push(["empty", room, left]) }));
  try {
    const result = await act();
    return { log, result };
  } finally {
    db.restore();
    to.mock.restore();
    into.mock.restore();
  }
};

const closedAndJoined = (room, sessionId) => [
  ["tell", room, SOCKET_EVENTS.SESSION_ENDED],
  ["empty", room, room],
  ["recordings", sessionId],
];

// ── Over REST ───────────────────────────────────────────────────────────────

const endOverRest = (user = HOST) => request(app).delete("/api/sessions/4/end").set("Cookie", cookieFor(user));

test("REST: the host ends it — the room is closed, then open recordings are joined", async () => {
  const { log, result } = await run({ endedRow: SESSION }, () => endOverRest());
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: 4, host_id: 10, title: "שיעור חי", is_active: false }, "no room token, no storage key");
  assert.deepEqual(log, [["end", "by id", ["4", 10]], ...closedAndJoined("room-abc", 4)]);
});

test("REST: ending a session already over answers it again — and closes its room again", async () => {
  const { log, result } = await run({ endedRow: null, existing: SESSION }, () => endOverRest());
  assert.equal(result.status, 200);
  assert.deepEqual(log, [["end", "by id", ["4", 10]], ...closedAndJoined("room-abc", 4)]);
});

test("REST: somebody else's session is refused, and nothing follows", async () => {
  const { log, result } = await run({ endedRow: null, existing: SESSION, user: OTHER }, () => endOverRest(OTHER));
  assert.equal(result.status, 403);
  assert.equal(result.body.code, "SESSION_FORBIDDEN");
  assert.deepEqual(log, [["end", "by id", ["4", 11]]]);
});

// ── Over the socket ─────────────────────────────────────────────────────────

const [onConnection] = io.of("/").listeners("connection");

// A connected socket of `user`; returns its END_SESSION handler and what it was sent.
const connect = (user) => {
  const handlers = new Map();
  const sent = [];
  const socket = {
    id: `sock-${user.id}`,
    user: { id: user.id, role: user.role, displayName: null },
    rooms: new Set([`sock-${user.id}`]),
    on: (event, handler) => handlers.set(event, handler),
    emit: (event, payload) => sent.push([event, payload]),
  };
  onConnection(socket);
  return { endSession: handlers.get(SOCKET_EVENTS.END_SESSION), sent };
};

test("socket: the host ends it — the room is closed, then open recordings are joined", async () => {
  const host = connect(HOST);
  const { log } = await run({ endedRow: SESSION }, () => host.endSession({ roomToken: "room-abc" }));
  assert.deepEqual(log, [["end", "by room", ["room-abc", 10]], ...closedAndJoined("room-abc", 4)]);
  assert.deepEqual(host.sent, [], "nothing is sent back to the host alone");
});

test("socket: anyone but the host is told so, and nothing follows", async () => {
  const other = connect(OTHER);
  const { log } = await run({ endedRow: null }, () => other.endSession({ roomToken: "room-abc" }));
  assert.deepEqual(log, [["end", "by room", ["room-abc", 11]]]);
  assert.deepEqual(other.sent, [[SOCKET_EVENTS.SESSION_ERROR, { message: "Only the host can end the session" }]]);
});

test("socket: a failure is reported to the host, and nothing follows", async () => {
  const host = connect(HOST);
  const { log } = await run({ failUpdate: true }, () => host.endSession({ roomToken: "room-abc" }));
  assert.deepEqual(log, [["end", "by room", ["room-abc", 10]]]);
  assert.deepEqual(host.sent, [[SOCKET_EVENTS.SESSION_ERROR, { message: "Could not end the session" }]]);
});

// ── A third door would have to do the same ──────────────────────────────────
//
// Each door ends the row through servicesSessions; whatever calls one of those
// must follow it with afterSessionEnded, or its room stays open and its
// recording unjoined — the bug the REST door had before it was given one.

test("every caller that ends a session's row follows it with afterSessionEnded", async () => {
  const { serverSourceFiles } = await import("./sourceFiles.js");
  const files = await serverSourceFiles();
  // A call, not a declaration: the controller's own handler is also named
  // endSession, and `endSession = async (` does not match.
  const enders = files.filter(({ file, source }) =>
    !file.endsWith("servicesSessions.js") && /\bendSession(ByRoomToken)?\(/.test(source));
  assert.ok(enders.length >= 2, `found ${enders.length} doors, expected the REST route and the socket`);
  const forgetting = enders.filter(({ source }) => !/\bafterSessionEnded\(/.test(source)).map(({ file }) => file);
  assert.deepEqual(forgetting, [], `end the session, then call afterSessionEnded: ${forgetting.join(", ")}`);
});
