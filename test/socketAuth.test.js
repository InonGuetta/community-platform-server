import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { authenticateSocket, sharesRoomWith, exceedsCapacity } from "../sockets/socketManager.js";

// The socket side of authentication and addressing.
//
// Driven over plain objects rather than a running server: the handshake only ever
// reads a cookie header, and the addressing rule only reads a room map and a
// socket id. Standing up socket.io to assert either would test socket.io. This is
// the same trade the client's peerMesh.js makes with RTCPeerConnection, and for
// the same reason — the parts that actually broke here are rules, not plumbing.

const socketWithToken = (token) => ({
  id: "sock-1",
  handshake: { headers: { cookie: token ? `token=${encodeURIComponent(token)}` : "" } },
});

// Resolves with whatever authenticateSocket passed to next(): an Error on
// refusal, undefined on success.
const handshake = (socket) =>
  new Promise((resolve) => authenticateSocket(socket, resolve));

const tokenFor = (id = 7, role = "student") =>
  jwt.sign({ id, email: "u@example.com", role }, process.env.JWT_SECRET, { expiresIn: "1h" });

// ── The handshake asks the database, not the token ──────────────────────────

test("a socket with no cookie is refused", async () => {
  const err = await handshake(socketWithToken(null));
  assert.ok(err instanceof Error);
});

test("a token signed with another secret is refused", async () => {
  const forged = jwt.sign({ id: 1, role: "admin" }, "not-the-real-secret");
  const err = await handshake(socketWithToken(forged));
  assert.ok(err instanceof Error);
});

// The whole point of the fix. The signature is genuine and unexpired; the account
// behind it is gone or deactivated, which is what the query's is_active filter
// answers. Before this, such a socket connected and could signal for seven days.
test("a valid token for a deactivated user is refused", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const err = await handshake(socketWithToken(tokenFor(7)));
    assert.ok(err instanceof Error, "a closed account must not reach the signalling layer");
  } finally {
    stub.restore();
  }
});

test("an active user is admitted", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 7, email: "u@example.com", role: "student" }] }));
  try {
    const socket = socketWithToken(tokenFor(7));
    const err = await handshake(socket);
    assert.equal(err, undefined);
    assert.deepEqual(socket.user, { id: 7, role: "student" });
  } finally {
    stub.restore();
  }
});

// Mirrors the REST test of the same name. A token minted while the user was an
// admin must not still carry admin into the room.
test("the role comes from the row, not from the token", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 7, email: "u@example.com", role: "student" }] }));
  try {
    const socket = socketWithToken(tokenFor(7, "admin"));
    await handshake(socket);
    assert.equal(socket.user.role, "student", "the demoted user kept their old role");
  } finally {
    stub.restore();
  }
});

test("a database failure refuses rather than admitting", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("Connection terminated");
  });
  try {
    const err = await handshake(socketWithToken(tokenFor(7)));
    assert.ok(err instanceof Error, "an unverifiable identity is not an authenticated one");
  } finally {
    stub.restore();
  }
});

// ── A peer is addressable only from inside a shared room ────────────────────

// io.sockets.adapter.rooms is a Map of room name → Set of socket ids; a socket's
// own `rooms` always contains its id alongside any room it joined.
const world = (rooms) => ({ sockets: { adapter: { rooms: new Map(Object.entries(rooms).map(([k, v]) => [k, new Set(v)])) } } });

test("a peer in the same room is addressable", () => {
  const io = world({ "room-a": ["sock-1", "sock-2"] });
  const socket = { id: "sock-1", rooms: new Set(["sock-1", "room-a"]) };
  assert.equal(sharesRoomWith(io, socket, "sock-2"), true);
});

// The hole this closes: io.to(id) delivers to any connected socket, so an
// authenticated user could push offers and ICE candidates at someone in a room
// they had never joined.
test("a socket in another room is not addressable", () => {
  const io = world({ "room-a": ["sock-1"], "room-b": ["sock-9"] });
  const socket = { id: "sock-1", rooms: new Set(["sock-1", "room-a"]) };
  assert.equal(sharesRoomWith(io, socket, "sock-9"), false);
});

test("a socket that has joined no room can address nobody", () => {
  const io = world({ "room-a": ["sock-2"] });
  const socket = { id: "sock-1", rooms: new Set(["sock-1"]) };
  assert.equal(sharesRoomWith(io, socket, "sock-2"), false);
});

test("the private per-socket room is not a shared room", () => {
  // Every socket sits in a room named after its own id. Counting that as
  // membership would make every socket a peer of every other.
  const io = world({ "sock-1": ["sock-1"], "sock-2": ["sock-2"] });
  const socket = { id: "sock-1", rooms: new Set(["sock-1"]) };
  assert.equal(sharesRoomWith(io, socket, "sock-2"), false);
});

test("a missing or self-addressed target is refused", () => {
  const io = world({ "room-a": ["sock-1", "sock-2"] });
  const socket = { id: "sock-1", rooms: new Set(["sock-1", "room-a"]) };
  for (const bad of [undefined, null, 42, {}, "sock-1"]) {
    assert.equal(sharesRoomWith(io, socket, bad), false, `${String(bad)} should not be addressable`);
  }
});

// ── Capacity, counted after the join ────────────────────────────────────────

test("capacity is measured against a count that includes the joiner", () => {
  // The join now happens before the count, so `occupants` already includes the
  // socket being admitted — which is why the comparison is > and not >=. The
  // fourth arrival into a room of three is the one that must be turned away.
  assert.equal(exceedsCapacity(3, 3), false, "the seat that fills the room is allowed");
  assert.equal(exceedsCapacity(4, 3), true, "one past the limit is refused");
});

test("a session with no limit is never full", () => {
  for (const noLimit of [null, undefined, 0]) {
    assert.equal(exceedsCapacity(500, noLimit), false);
  }
});
