import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { readFile } from "fs/promises";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { getTranscriptByMediaId } from "../services/transcripts/chunks.js";
import { searchTranscripts } from "../services/transcripts/search.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A lesson belonging to a course must be refused on EVERY surface it can be
// reached through, not merely hidden from the archive listing.
//
// That is the whole risk of this change. Adding a condition to the list endpoint
// is the obvious half; the half that leaks is the six other doors onto the same
// row — the direct read, the byte stream, the two downloads, the transcript, and
// above all the search, which reaches chunk text without touching media_items in
// any way the naive fix would notice.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const STUDENT_ROW = { id: 7, email: "s@example.com", role: "student" };
const token = jwt.sign({ id: 7, email: "s@example.com", role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

// A published video that belongs to course 5 — which this student is not in.
const LESSON = {
  id: 3,
  is_published: true,
  course_id: 5,
  media_type: "video",
  s3_key: "local/x.mp4",
  title: "שיעור בקורס",
};

// verifyToken's lookup, then the media read, then the enrolment lookup — which
// comes back empty, because this student is in no course at all.
const asOutsider = () =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    return { rows: [] };
  });

const SURFACES = [
  { name: "the direct read", path: "/api/media/3" },
  { name: "the byte stream", path: "/api/media/3/stream" },
  { name: "the download", path: "/api/media/3/download" },
  { name: "the audio extract", path: "/api/media/3/download/audio" },
  { name: "the transcript", path: "/api/transcripts/3" },
];

test("every route onto a course lesson refuses a student who is not enrolled", async (t) => {
  for (const surface of SURFACES) {
    const db = asOutsider();
    try {
      const res = await request(app).get(surface.path).set("Cookie", `token=${token}`);
      await t.test(`${surface.name} — ${surface.path}`, () => {
        assert.equal(res.status, 404, `answered ${res.status}; a lesson they may not see must not exist`);
      });
    } finally {
      db.restore();
    }
  }
});

// 404 and not 403, everywhere and for the same reason: telling an outsider that
// a lesson exists but is closed to them turns the id space into a catalogue of
// what every course contains.
test("the refusal does not admit the lesson exists", async () => {
  const db = asOutsider();
  try {
    const res = await request(app).get("/api/media/3").set("Cookie", `token=${token}`);
    assert.equal(res.body.code, "MEDIA_NOT_FOUND");
    assert.equal(JSON.stringify(res.body).includes("שיעור בקורס"), false, "the title must not leak");
  } finally {
    db.restore();
  }
});

test("an enrolled student reaches the same lesson", async () => {
  const db = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
    if (/FROM media_items/i.test(text)) return { rows: [LESSON] };
    if (/FROM enrollments/i.test(text)) return { rows: [{ course_id: 5 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/media/3").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "שיעור בקורס");
  } finally {
    db.restore();
  }
});

// The general library is what every item uploaded before courses existed is.
// Gating those on enrolment would have emptied the archive for every student.
test("a lesson in no course is still reachable by anyone", async () => {
  const db = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [STUDENT_ROW] };
    if (/FROM media_items/i.test(text)) return { rows: [{ ...LESSON, course_id: null }] };
    if (/FROM enrollments/i.test(text)) return { rows: [] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/media/3").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
  } finally {
    db.restore();
  }
});

// ── Search, in all three modes ──────────────────────────────────────────────
//
// The mode that matters most is hybrid, and the reason is in search.js's own
// header: its two ranking CTEs take the top FUSE_DEPTH candidates BEFORE the
// final SELECT, so a predicate applied only at the end would let lessons the
// student may not see occupy candidate slots — handing them a shorter, worse
// list rather than an equivalent one, with no error anywhere.
//
// Only the keyword mode is driven end to end. The other two call embedQuery,
// which is a real OpenAI request, and this suite is hermetic by design — so they
// are asserted on the SQL they build instead.

test("keyword search filters on the caller's courses", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await searchTranscripts("תפילה", "keyword", []);
    const [call] = stub.calls;
    assert.match(call.text, /course_id = ANY/, "the enrolment condition must reach the query");
    assert.deepEqual(call.params[1], []);
  } finally {
    stub.restore();
  }
});

test("the predicate sits inside each of the hybrid ranking CTEs", async () => {
  // A structural assertion, on the module's own text, because reaching
  // searchHybrid at runtime means calling embedQuery — a real OpenAI request,
  // which this suite does not make.
  //
  // What it guards is stated in search.js's header and is easy to undo by
  // accident: the kw and vec CTEs each take their top FUSE_DEPTH rows before the
  // final SELECT ever runs, so a predicate present only at the end would let
  // lessons the student may not see consume candidate slots. The list would come
  // back shorter and worse rather than filtered, and nothing would report it.
  const source = await readFile(new URL("../services/transcripts/search.js", import.meta.url), "utf8");

  const cte = (name) => {
    const start = source.indexOf(`${name} AS (`);
    assert.notEqual(start, -1, `the ${name} CTE should still exist`);
    return source.slice(start, source.indexOf("LIMIT ${FUSE_DEPTH}", start));
  };

  for (const name of ["kw", "vec"]) {
    assert.match(cte(name), /\$\{VISIBLE\("\$3"\)\}/, `the ${name} CTE must filter before it ranks`);
  }
});

test("a student in no course sees nothing from any course", async () => {
  // The predicate resolves to "published AND course_id IS NULL" for this caller,
  // which is the general library and nothing else.
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await searchTranscripts("שאלה", "keyword", []);
    assert.deepEqual(stub.calls[0].params[1], [], "an empty enrolment list is a real answer");
  } finally {
    stub.restore();
  }
});

// ── The transcript inherits the lesson's visibility ─────────────────────────

test("the transcript service refuses before reading any chunk", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [{ is_published: true, course_id: 5 }] };
    return { rows: [] };
  });
  try {
    await assert.rejects(() => getTranscriptByMediaId(3, []), { statusCode: 404 });
    assert.equal(
      stub.calls.some((c) => /FROM transcript_chunks/i.test(c.text)),
      false,
      "a refused request must not read the text it was refused"
    );
  } finally {
    stub.restore();
  }
});

test("the transcript is returned to an enrolled student", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [{ is_published: true, course_id: 5 }] };
    if (/FROM transcripts/i.test(text)) return { rows: [{ media_id: 3, status: "done" }] };
    return { rows: [] };
  });
  try {
    const transcript = await getTranscriptByMediaId(3, [5]);
    assert.equal(transcript.status, "done");
  } finally {
    stub.restore();
  }
});
