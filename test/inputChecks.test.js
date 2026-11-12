import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { createSession } from "../controllers/controllersSessions.js";
import { createCourse, updateCourse } from "../services/servicesCourses.js";
import { createPlaylist, renamePlaylist } from "../services/servicesSaves.js";

// The input checks on three writes — a live session, a course, a saved list —
// with the exact 400 each answers, the order they are asked in, and what a
// valid input becomes on its way to the database. Pinned before the checks
// moved into lib/validate.js, so the move cannot reword one or reorder them.

const res = () => {
  const out = { statusCode: null, body: null };
  out.status = (code) => { out.statusCode = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  return out;
};
const HOST = { id: 7, role: "lecturer" };
const session = (body) => createSession({ body, user: HOST }, res());
const refuses = (promise, message) => assert.rejects(promise, (err) => {
  assert.equal(err.statusCode ?? err.status, 400);
  assert.equal(err.message, message);
  return true;
});
const MINUTE = 60 * 1000;

test("a session's title may be absent, and is at most 255 characters", async () => {
  await refuses(session({ title: "x".repeat(256), sessionType: "group" }), "Title must be at most 255 characters");
  // Checked before the type: both wrong answers with the title.
  await refuses(session({ title: "x".repeat(256), sessionType: "party" }), "Title must be at most 255 characters");
});

test("a session's type is one of the enum's three", async () => {
  await refuses(session({ sessionType: "party" }), 'Invalid session type: "party"');
  await refuses(session({}), 'Invalid session type: "undefined"');
});

test("a session's capacity is a whole number from 1 to 100, or absent", async () => {
  for (const value of [0, 101, 1.5, "abc", -3]) {
    await refuses(session({ sessionType: "group", maxParticipants: value }), "maxParticipants must be a whole number between 1 and 100");
  }
});

test("a session's time is a real date, a minute to a year ahead, or absent", async () => {
  await refuses(session({ sessionType: "group", scheduledAt: "tomorrow-ish" }), "scheduledAt must be a valid date");
  await refuses(session({ sessionType: "group", scheduledAt: new Date(Date.now() + 10 * 1000).toISOString() }), "A scheduled session must be at least a minute away");
  await refuses(session({ sessionType: "group", scheduledAt: new Date(Date.now() + 400 * 24 * 60 * MINUTE).toISOString() }), "A session cannot be scheduled more than a year ahead");
  // Capacity is checked before the time.
  await refuses(session({ sessionType: "group", maxParticipants: 0, scheduledAt: "nope" }), "maxParticipants must be a whole number between 1 and 100");
});

test("a valid session reaches the database trimmed, numbered and in ISO time", async () => {
  const when = new Date(Date.now() + 10 * MINUTE);
  const stub = stubPoolQuery(pool, (text) =>
    /INSERT INTO live_sessions/.test(text) || /FROM live_sessions/.test(text) ? { rows: [{ id: 3, host_id: 7 }] } : { rows: [] });
  try {
    const out = res();
    await createSession({ body: { title: "  שיעור  ", sessionType: "webinar", maxParticipants: "12", scheduledAt: when.toISOString() }, user: HOST }, out);
    const insert = stub.calls.find((c) => /INSERT INTO live_sessions/.test(c.text));
    const [hostId, title, type, , participants, scheduledAt, courseId] = insert.params;
    assert.deepEqual([hostId, title, type, participants, scheduledAt, courseId], [7, "שיעור", "webinar", 12, when.toISOString(), null]);
    assert.equal(out.statusCode, 201);

    stub.calls.length = 0;
    await createSession({ body: { title: "   ", sessionType: "group", scheduledAt: "" }, user: HOST }, res());
    const second = stub.calls.find((c) => /INSERT INTO live_sessions/.test(c.text)).params;
    assert.deepEqual([second[1], second[4], second[5]], [null, null, null]);
    // The audience notice is sent without being awaited; let it finish against
    // the stub rather than reach for a database after it is restored.
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    stub.restore();
  }
});

test("a course needs a title, of at most 255 characters", async () => {
  await refuses(createCourse({ title: "   " }), "Course title is required");
  await refuses(createCourse({}), "Course title is required");
  await refuses(createCourse({ title: "x".repeat(256) }), "Title must be at most 255 characters");
  await refuses(updateCourse(1, { title: "" }), "Course title is required");
  await refuses(updateCourse(1, { title: "x".repeat(256) }), "Title must be at most 255 characters");
});

test("a course's title reaches the database trimmed, and an edit without one leaves it", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 4, title: "t" }] }));
  try {
    await createCourse({ title: "  גמרא  " });
    assert.equal(stub.calls.find((c) => /INSERT INTO courses/.test(c.text)).params[0], "גמרא");
    stub.calls.length = 0;
    await updateCourse(4, { description: "x" });
    assert.equal(stub.calls.find((c) => /UPDATE courses/.test(c.text)).params.includes(null), true);
  } finally {
    stub.restore();
  }
});

test("a saved list needs a title, of at most 120 characters", async () => {
  await refuses(createPlaylist(1, ""), "List title is required");
  await refuses(createPlaylist(1, 42), "List title is required");
  await refuses(createPlaylist(1, "x".repeat(121)), "Title must be at most 120 characters");
  await refuses(renamePlaylist(1, 2, "  "), "List title is required");
  await refuses(renamePlaylist(1, 2, "x".repeat(121)), "Title must be at most 120 characters");
});

test("a list's new name reaches the database trimmed", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 2, title: "t" }] }));
  try {
    await renamePlaylist(1, 2, "  לשבת  ");
    assert.equal(stub.calls.find((c) => /UPDATE playlists/.test(c.text)).params.includes("לשבת"), true);
  } finally {
    stub.restore();
  }
});
