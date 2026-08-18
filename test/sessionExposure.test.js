import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// What a session looks like from outside, and the two fields that must never be
// part of it.
//
// room_token is what ARCHITECTURE.md calls the capability for entering a room —
// and it used to travel on every row of the public sessions list, for ended
// sessions as well as live ones, next to the storage key of any recording. The
// capability model was incoherent rather than merely leaky: knowing the token was
// said to be what granted access, and the token was published to everybody.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const STUDENT = { id: 7, email: "s@example.com", role: "student" };
const token = jwt.sign({ id: 7, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const SECRET_TOKEN = "11111111-2222-3333-4444-555555555555";

const SESSION = {
  id: 3,
  host_id: 2,
  title: "מפגש",
  session_type: "group",
  room_token: SECRET_TOKEN,
  recording_s3_key: "uploads/secret-recording.webm",
  is_active: true,
  started_at: "2026-08-12T09:00:00.000Z",
  scheduled_at: null,
  state: "live",
};

const stubWith = (session) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    return { rows: session ? [session] : [] };
  });

const SESSION_READS = [
  { name: "the live list", path: "/api/sessions/active" },
  { name: "the upcoming list", path: "/api/sessions/upcoming" },
  { name: "one session", path: "/api/sessions/3" },
];

test("no session read hands out the room token or the recording key", async (t) => {
  for (const read of SESSION_READS) {
    const db = stubWith(SESSION);
    try {
      const res = await request(app).get(read.path).set("Cookie", `token=${token}`);
      const body = JSON.stringify(res.body);
      await t.test(`${read.name} — ${read.path}`, () => {
        assert.equal(res.status, 200);
        assert.equal(body.includes(SECRET_TOKEN), false, "room_token must not leave the server");
        assert.equal(body.includes("secret-recording"), false, "recording_s3_key must not either");
      });
    } finally {
      db.restore();
    }
  }
});

// The rest of the row still has to arrive, or stripping two fields would have
// been indistinguishable from breaking the endpoint.
test("everything else about a session still comes back", async () => {
  const db = stubWith(SESSION);
  try {
    const res = await request(app).get("/api/sessions/3").set("Cookie", `token=${token}`);
    assert.equal(res.body.id, 3);
    assert.equal(res.body.title, "מפגש");
    assert.equal(res.body.state, "live");
  } finally {
    db.restore();
  }
});

// The one route that answers with a token, and only after the server has decided
// this caller may enter.
test("joining a live session yields the token", async () => {
  const db = stubWith(SESSION);
  try {
    const res = await request(app).post("/api/sessions/3/join").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.roomToken, SECRET_TOKEN);
    // Even here the session that travels alongside it is the stripped one — the
    // token appears once, under its own key, rather than twice in two shapes.
    assert.equal(res.body.session.room_token, undefined);
  } finally {
    db.restore();
  }
});

// A scheduled room does not exist to walk into yet. Refusing at the join is what
// stops the first person to try the link ten minutes early from sitting alone in
// a room the host has not opened.
test("joining a scheduled session is refused, with a code that says why", async () => {
  const db = stubWith({ ...SESSION, started_at: null, scheduled_at: "2030-01-01T10:00:00.000Z", state: "scheduled" });
  try {
    const res = await request(app).post("/api/sessions/3/join").set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "SESSION_NOT_STARTED");
  } finally {
    db.restore();
  }
});

test("joining an ended session is refused", async () => {
  const db = stubWith({ ...SESSION, is_active: false, state: "ended" });
  try {
    const res = await request(app).post("/api/sessions/3/join").set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
    assert.equal(JSON.stringify(res.body).includes(SECRET_TOKEN), false);
  } finally {
    db.restore();
  }
});

// Starting is host-only, and a student is not the host of this one.
test("a non-host cannot start a session", async () => {
  const db = stubWith({ ...SESSION, started_at: null, state: "scheduled" });
  try {
    const res = await request(app).post("/api/sessions/3/start").set("Cookie", `token=${token}`);
    // requireRole refuses a student before ownership is even considered.
    assert.equal(res.status, 403);
  } finally {
    db.restore();
  }
});
