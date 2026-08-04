import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { canManageMedia, isPrivileged } from "../lib/permissions.js";
import * as controllersMedia from "../controllers/controllersMedia.js";
import * as controllersTranscripts from "../controllers/controllersTranscripts.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Importing the transcripts controller reaches the Bull queues, and constructing
// a Bull queue opens a Redis client that retries on a timer forever. Nothing in
// the suite connects to a real Redis (setup.js points at a dead port), but those
// timers still keep the event loop alive and the whole test FILE times out with
// every assertion already green. Closing them is this file's job because it is
// what opened them.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// requireRole gets a lecturer as far as these handlers; only the ownership check
// decides whether they may act on THIS item. Before it existed, any lecturer
// could delete or unpublish any item in the library, and edit any transcript.

const ADMIN = { id: 1, role: "admin" };
const OWNER = { id: 2, role: "lecturer" };
const OTHER = { id: 3, role: "lecturer" };
const STUDENT = { id: 4, role: "student" };

const ITEM = { id: 7, uploader_id: 2, s3_key: "local/x.mp3", is_published: true };

// ── the rule itself ─────────────────────────────────────────────────────────

test("an admin manages any item", () => {
  assert.equal(canManageMedia(ADMIN, ITEM), true);
});

test("a lecturer manages their own item", () => {
  assert.equal(canManageMedia(OWNER, ITEM), true);
});

test("a lecturer does not manage someone else's item", () => {
  assert.equal(canManageMedia(OTHER, ITEM), false);
});

test("a student manages nothing, even their own upload", () => {
  assert.equal(canManageMedia(STUDENT, { uploader_id: 4 }), false);
});

// The trap servicesUsers already hit once: an id that has been through a route
// param or a JSON round-trip is a string, and === would silently say "not yours"
// to the actual owner.
test("a string id still matches the numeric owner id", () => {
  assert.equal(canManageMedia({ id: "2", role: "lecturer" }, ITEM), true);
  assert.equal(canManageMedia(OWNER, { uploader_id: "2" }), true);
});

test("a missing id is never a match", () => {
  assert.equal(canManageMedia({ role: "lecturer" }, ITEM), false);
  assert.equal(canManageMedia(OWNER, {}), false);
  assert.equal(canManageMedia(OWNER, undefined), false);
});

test("ownership does not widen who may see drafts", () => {
  // isPrivileged still governs reads; the two rules must stay independent.
  assert.equal(isPrivileged(OTHER), true);
  assert.equal(isPrivileged(STUDENT), false);
});

// ── the write paths that enforce it ─────────────────────────────────────────

const stubMediaRow = (row = ITEM) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/i.test(text)) return { rows: [row] };
    if (/^\s*UPDATE media_items/i.test(text)) return { rows: [row] };
    return { rows: [] };
  });

const fakeReq = (user, body = {}) => ({ user, params: { id: "7", mediaId: "7" }, body });
const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
};

const refuses = async (handler, user) => {
  const db = stubMediaRow();
  try {
    const err = await handler(fakeReq(user), fakeRes()).catch((e) => e);
    assert.equal(err?.statusCode, 403, "a non-owner lecturer must be refused");
    return db;
  } finally {
    db.restore();
  }
};

test("updateMedia refuses a lecturer who is not the uploader", async () => {
  await refuses(controllersMedia.updateMedia, OTHER);
});

test("updateMedia allows the uploader", async () => {
  const db = stubMediaRow();
  try {
    const res = fakeRes();
    await controllersMedia.updateMedia(fakeReq(OWNER, { title: "x" }), res);
    assert.equal(res.statusCode, 200);
  } finally {
    db.restore();
  }
});

test("updateMedia allows an admin", async () => {
  const db = stubMediaRow();
  try {
    const res = fakeRes();
    await controllersMedia.updateMedia(fakeReq(ADMIN, { title: "x" }), res);
    assert.equal(res.statusCode, 200);
  } finally {
    db.restore();
  }
});

// The refusal has to land before the file is unlinked, not after — otherwise the
// stored object is gone regardless of the 403.
test("deleteMedia refuses a non-owner without touching storage", async () => {
  const db = await refuses(controllersMedia.deleteMedia, OTHER);
  assert.equal(
    db.calls.some((c) => /^\s*DELETE FROM media_items/i.test(c.text)),
    false,
    "the row must survive a refused delete"
  );
});

// Each of these would otherwise reach a queue or a paid GPT-4o call.
for (const name of ["updateTranscript", "triggerPipeline", "fixHebrew", "generateKeyPointHeadings"]) {
  test(`${name} refuses a lecturer who does not own the media`, async () => {
    await refuses(controllersTranscripts[name], OTHER);
  });

  test(`${name} refuses before doing any work`, async () => {
    const db = stubMediaRow();
    try {
      await controllersTranscripts[name](fakeReq(OTHER), fakeRes()).catch(() => {});
      assert.equal(
        db.calls.every((c) => /FROM media_items/i.test(c.text)),
        true,
        "the only query on a refused request should be the ownership lookup"
      );
    } finally {
      db.restore();
    }
  });
}
