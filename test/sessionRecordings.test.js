import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import {
  startRecording, savePart, finishRecording, finishOpenRecordings, contiguousParts, PARTS_DIR,
} from "../services/servicesSessionRecordings.js";
import { recordingStatePayload } from "../sockets/socketManager.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Recording a live session (PRD REC-1). The pool is stubbed; the parts are
// real files, under ids no real recording will have, removed afterwards.

const IDS = [990001, 990002, 990003, 990004];
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
  for (const id of IDS) {
    await fs.rm(path.join(PARTS_DIR, String(id)), { recursive: true, force: true });
    await fs.rm(path.join(LOCAL_UPLOAD_DIR, `session-7-recording-${id}.webm`), { force: true });
  }
});

const HOST = 3;
const SESSION = { id: 7, host_id: HOST, is_active: true, started_at: "2026-11-07T10:00:00Z" };
const recordingRow = (id, extra = {}) => ({
  id, session_id: 7, host_id: HOST, status: "recording", mime_type: "audio/webm;codecs=opus",
  parts: 0, bytes: 0, s3_key: null, ...extra,
});

// One stub for the recording paths. `rec` is the row the recording reads find
// (null: none); `updates` collects what was written.
const db = ({ session = SESSION, rec = null, open = [] } = {}) => {
  const updates = [];
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM live_sessions WHERE id=\$1/.test(text)) return { rows: session ? [session] : [] };
    if (/INSERT INTO session_recordings/.test(text)) return { rows: [recordingRow(IDS[3])] };
    if (/WHERE session_id=\$1 AND status='recording'/.test(text)) return { rows: open };
    if (/UPDATE session_recordings SET status='failed'/.test(text)) {
      updates.push({ claim: params[0] });
      return { rows: [{ ...(rec ?? open[0]), status: "failed" }] };
    }
    if (/SET status='finished'/.test(text)) {
      updates.push({ finished: params });
      return { rows: [{ ...rec, status: "finished", s3_key: params[1], parts: params[2], bytes: params[3] }] };
    }
    if (/FROM session_recordings/.test(text)) return { rows: rec ? [rec] : [] };
    return { rows: [] };
  });
  return { stub, updates };
};

test("starting needs an audio format, the session's host, and a running session", async () => {
  let { stub } = db();
  try {
    await assert.rejects(startRecording(7, HOST, "video/webm"), { statusCode: 400 });
    await assert.rejects(startRecording(7, 99, "audio/webm"), { statusCode: 403, code: "SESSION_FORBIDDEN" });
  } finally {
    stub.restore();
  }
  ({ stub } = db({ session: { ...SESSION, is_active: false } }));
  try {
    await assert.rejects(startRecording(7, HOST, "audio/webm"), { statusCode: 409, code: "SESSION_NOT_STARTED" });
  } finally {
    stub.restore();
  }
  ({ stub } = db());
  try {
    const rec = await startRecording(7, HOST, "audio/webm;codecs=opus");
    assert.equal(rec.status, "recording");
  } finally {
    stub.restore();
  }
});

test("a part is stored by its number, and sending it again replaces it", async () => {
  const { stub } = db({ rec: recordingRow(IDS[0]) });
  try {
    await savePart({ sessionId: 7, recordingId: IDS[0], hostId: HOST, partNumber: 0, body: Buffer.from("first") });
    await savePart({ sessionId: 7, recordingId: IDS[0], hostId: HOST, partNumber: 0, body: Buffer.from("again") });
    const { files, bytes } = await contiguousParts(IDS[0]);
    assert.equal(files.length, 1);
    assert.equal(bytes, 5);
    assert.equal(await fs.readFile(files[0], "utf8"), "again");
  } finally {
    stub.restore();
  }
});

test("a part is refused when it is empty, misnumbered, someone else's or for a finished recording", async () => {
  let { stub } = db({ rec: recordingRow(IDS[1]) });
  const part = (over) => savePart({ sessionId: 7, recordingId: IDS[1], hostId: HOST, partNumber: 1, body: Buffer.from("x"), ...over });
  try {
    await assert.rejects(part({ body: Buffer.alloc(0) }), { statusCode: 400 });
    await assert.rejects(part({ partNumber: -1 }), { statusCode: 400 });
    await assert.rejects(part({ partNumber: Number.NaN }), { statusCode: 400 });
  } finally {
    stub.restore();
  }
  ({ stub } = db({ rec: null }));
  try {
    await assert.rejects(part({}), { statusCode: 404, code: "RECORDING_NOT_FOUND" });
  } finally {
    stub.restore();
  }
  ({ stub } = db({ rec: recordingRow(IDS[1], { status: "finished" }) }));
  try {
    await assert.rejects(part({}), { statusCode: 409, code: "RECORDING_CLOSED" });
  } finally {
    stub.restore();
  }
});

test("finishing joins the gapless run of parts from 0, in order, into one file", async () => {
  const id = IDS[2];
  const { stub, updates } = db({ rec: recordingRow(id) });
  try {
    for (const [n, text] of [[0, "AA"], [2, "CC"], [1, "BB"], [4, "EE"]]) {
      await savePart({ sessionId: 7, recordingId: id, hostId: HOST, partNumber: n, body: Buffer.from(text) });
    }
    const done = await finishRecording(7, id, HOST);
    // Part 3 never arrived, so part 4 cannot follow: 0, 1, 2.
    assert.equal(done.status, "finished");
    assert.equal(done.s3_key, `local/session-7-recording-${id}.webm`);
    assert.equal(done.parts, 3);
    assert.equal(await fs.readFile(path.join(LOCAL_UPLOAD_DIR, `session-7-recording-${id}.webm`), "utf8"), "AABBCC");
    // Claimed before it was joined; the parts are gone once it is stored.
    assert.equal(updates[0].claim, id);
    await assert.rejects(fs.stat(path.join(PARTS_DIR, String(id))));
  } finally {
    stub.restore();
  }
});

test("finishing one already finished answers it as it is", async () => {
  const { stub, updates } = db({ rec: recordingRow(IDS[2], { status: "finished", s3_key: "local/x.webm" }) });
  try {
    const done = await finishRecording(7, IDS[2], HOST);
    assert.equal(done.s3_key, "local/x.webm");
    assert.equal(updates.length, 0);
  } finally {
    stub.restore();
  }
});

test("ending a session never fails because of its recording", async () => {
  const stub = stubPoolQuery(pool, () => { throw new Error("database gone"); });
  try {
    assert.deepEqual(await finishOpenRecordings(7), []);
  } finally {
    stub.restore();
  }
});

// ── Who is recorded ─────────────────────────────────────────────────────────

test("the room is told who is recorded: the host, and only those who said yes", () => {
  assert.deepEqual(recordingStatePayload(null), { active: false, recordingId: null, hostSocketId: null, consented: [], declined: [] });
  const state = {
    recordingId: 5,
    hostSocketId: "host",
    answers: new Map([["a", { userId: 1, consented: true }], ["b", { userId: 2, consented: false }]]),
  };
  assert.deepEqual(recordingStatePayload(state), {
    active: true, recordingId: 5, hostSocketId: "host", consented: ["host", "a"], declined: ["b"],
  });
});

// ── Routes ──────────────────────────────────────────────────────────────────

const app = createApp();
const cookie = (id, role) => `token=${jwt.sign({ id, email: "x@example.com", role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

test("a part is sent as raw bytes, part 0 included, and answered 204", async () => {
  const id = IDS[3];
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [{ id: HOST, email: "x@example.com", role: "lecturer" }] };
    if (/FROM session_recordings/.test(text)) return { rows: [recordingRow(id)] };
    return { rows: [] };
  });
  try {
    const res = await request(app)
      .put(`/api/sessions/7/recordings/${id}/parts/0`)
      .set("Cookie", cookie(HOST, "lecturer"))
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("opus"));
    assert.equal(res.status, 204);
    const bad = await request(app)
      .put(`/api/sessions/7/recordings/${id}/parts/1e3`)
      .set("Cookie", cookie(HOST, "lecturer"))
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("x"));
    assert.equal(bad.status, 400);
  } finally {
    stub.restore();
  }
});

test("a student cannot start a recording", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    (/FROM users/i.test(text) ? { rows: [{ id: 8, email: "x@example.com", role: "student" }] } : { rows: [] }));
  try {
    const res = await request(app).post("/api/sessions/7/recordings").set("Cookie", cookie(8, "student")).send({ mimeType: "audio/webm" });
    assert.equal(res.status, 403);
  } finally {
    stub.restore();
  }
});
