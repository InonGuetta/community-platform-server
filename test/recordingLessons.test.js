import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { lessonFromRecording, lessonTitle, saveChatMessage } from "../services/servicesSessionRecordings.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A session's recording becoming a lesson, with its chat as an appendix
// (PRD REC-2, REC-3; migration 049). The queue is replaced; the pool stubbed.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const RECORDING = { id: 12, session_id: 7, host_id: 3, s3_key: "local/session-7-recording-12.webm", started_at: "2026-11-07T18:00:00Z" };
const SESSION = { id: 7, title: "עיון בגמרא", course_id: 4, started_at: "2026-11-07T17:55:00Z", host_name: "הרב לוי", finished: 1, part: 1 };

const db = ({ session = SESSION, failInsert = false } = {}) => {
  const seen = { media: null, link: null };
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM live_sessions s JOIN users/.test(text)) return { rows: session ? [session] : [] };
    if (/INSERT INTO media_items/.test(text)) {
      if (failInsert) throw new Error("database gone");
      seen.media = { text, params };
      return { rows: [{ id: 55 }] };
    }
    if (/INSERT INTO media_session_chat/.test(text)) {
      seen.link = { text, params };
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { stub, seen };
};

test("a finished recording becomes a draft lesson in the session's course, the host as its lecturer", async () => {
  const { stub, seen } = db();
  const triggered = [];
  try {
    const id = await lessonFromRecording(RECORDING, 1834, { trigger: async (mediaId) => { triggered.push(mediaId); } });
    assert.equal(id, 55);
    const [uploader, title, description, mediaType, s3Key, duration, , courseId, lecturerId, creator] = seen.media.params;
    assert.equal(uploader, 3);
    assert.equal(title, "עיון בגמרא — הקלטת מפגש");
    assert.match(description, /^הקלטה של המפגש "עיון בגמרא" מתאריך \d{2}\.\d{2}\.\d{4}\.$/);
    assert.equal(mediaType, "audio");
    assert.equal(s3Key, RECORDING.s3_key);
    assert.equal(duration, 1834);
    assert.equal(courseId, 4);
    assert.equal(lecturerId, 3);
    assert.equal(creator, "הרב לוי");
    // A draft: the INSERT never names is_published, so the column's FALSE holds.
    assert.doesNotMatch(seen.media.text, /is_published/);
    // Linked both ways, and the chat COPIED from the recording's own lines.
    assert.deepEqual(seen.link.params, [55, 7, 12]);
    assert.match(seen.link.text, /FROM session_recording_chat c[\s\S]+WHERE c\.recording_id = \$3/);
    assert.match(seen.link.text, /'offset'/);
    assert.deepEqual(triggered, [55]);
  } finally {
    stub.restore();
  }
});

test("a lesson is made even when processing cannot be queued", async () => {
  const { stub } = db();
  try {
    const id = await lessonFromRecording(RECORDING, null, { trigger: async () => { throw new Error("Redis down"); } });
    assert.equal(id, 55);
  } finally {
    stub.restore();
  }
});

test("a failure to make the lesson never fails the recording", async () => {
  const { stub } = db({ failInsert: true });
  try {
    assert.equal(await lessonFromRecording(RECORDING, null, { trigger: async () => {} }), null);
  } finally {
    stub.restore();
  }
});

test("a session recorded in more than one part numbers its lessons", () => {
  assert.equal(lessonTitle("עיון בגמרא", 1, 1), "עיון בגמרא — הקלטת מפגש");
  assert.equal(lessonTitle("עיון בגמרא", 2, 2), "עיון בגמרא — הקלטת מפגש (חלק 2)");
  assert.equal(lessonTitle("  ", 1, 1), "מפגש — הקלטת מפגש");
  assert.equal(lessonTitle("א".repeat(400), 3, 3).length, 255);
  assert.ok(lessonTitle("א".repeat(400), 3, 3).endsWith(" (חלק 3)"));
});

test("a chat line that cannot be kept never stops the chat", async () => {
  const stub = stubPoolQuery(pool, () => { throw new Error("database gone"); });
  try {
    await saveChatMessage(12, { id: 3, displayName: "הרב לוי" }, "שלום");
  } finally {
    stub.restore();
  }
});

// ── The appendix on the lesson page ─────────────────────────────────────────

const app = createApp();
const token = jwt.sign({ id: 9, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });
const STUDENT = { id: 9, email: "s@example.com", role: "student" };
const CHAT = [{ name: "הרב לוי", text: "המקור בדף ל\"ב", at: "2026-11-07T18:05:00Z" }];

const mediaDb = (media) => stubPoolQuery(pool, (text) => {
  if (/FROM users/i.test(text)) return { rows: [STUDENT] };
  if (/FROM enrollments/i.test(text)) return { rows: [] };
  if (/FROM media_session_chat/.test(text)) return { rows: [{ messages: CHAT }] };
  if (/FROM media_items/i.test(text)) return { rows: media ? [media] : [] };
  return { rows: [] };
});

test("the session's chat is read by whoever may see the lesson", async () => {
  const stub = mediaDb({ id: 55, is_published: true, course_id: null, uploader_id: 3 });
  try {
    const res = await request(app).get("/api/media/55/session-chat").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, CHAT);
  } finally {
    stub.restore();
  }
});

test("…and not by anyone else: a draft is a 404, like a lesson that does not exist", async () => {
  const stub = mediaDb({ id: 55, is_published: false, course_id: null, uploader_id: 3 });
  try {
    const res = await request(app).get("/api/media/55/session-chat").set("Cookie", `token=${token}`);
    assert.equal(res.status, 404);
  } finally {
    stub.restore();
  }
});
