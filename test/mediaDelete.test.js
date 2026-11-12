import "./setup.js";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR, localKeyFor, localPathOf, s3 } from "../lib/storage.js";
import * as controllersMedia from "../controllers/controllersMedia.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// Deleting a lesson, by its owner, all the way through: the row goes first,
// then the stored object — and a failure to remove the object never fails the
// delete, because by then the row (the thing the user asked to remove) is gone.
// permissions.test.js covers the refusals; this covers the delete itself.

const OWNER = { id: 2, role: "lecturer" };

const fakeRes = () => {
  const res = { statusCode: null, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

// The row the controller loads, and a record of what the DELETE saw.
const stubLesson = (s3Key, { onRowDelete = () => {} } = {}) =>
  stubPoolQuery(pool, (text) => {
    if (/^\s*DELETE FROM media_items/i.test(text)) {
      onRowDelete();
      return { rows: [{ id: 7 }] };
    }
    if (/FROM media_items m/i.test(text)) return { rows: [{ id: 7, uploader_id: 2, s3_key: s3Key, is_published: true }] };
    return { rows: [] };
  });

const deleteLesson = async () => {
  const res = fakeRes();
  await controllersMedia.deleteMedia({ params: { id: "7" }, user: OWNER, query: {} }, res);
  return res;
};

test("a local lesson's file is removed after its row", async () => {
  const key = localKeyFor(`__delete-test-${randomUUID()}.mp3`);
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(localPathOf(key), "audio");
  let fileWhenRowDeleted = null;
  const db = stubLesson(key, { onRowDelete: () => { fileWhenRowDeleted = fs.existsSync(localPathOf(key)); } });
  try {
    const res = await deleteLesson();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { deleted: true, id: "7" });
    assert.equal(fileWhenRowDeleted, true, "the row is deleted while the file is still there");
    assert.equal(fs.existsSync(localPathOf(key)), false, "and the file is gone afterwards");
  } finally {
    db.restore();
    fs.rmSync(localPathOf(key), { force: true });
  }
});

test("a local file already missing does not fail the delete", async () => {
  const db = stubLesson(localKeyFor(`__delete-test-${randomUUID()}.mp3`));
  try {
    const res = await deleteLesson();
    assert.equal(res.statusCode, 200);
  } finally {
    db.restore();
  }
});

test("an S3 lesson's object is deleted from the bucket after its row", async () => {
  const order = [];
  const send = mock.method(s3, "send", async (command) => { order.push(command.constructor.name); return {}; });
  const db = stubLesson("uploads/1700-abc.mp3", { onRowDelete: () => order.push("row") });
  try {
    const res = await deleteLesson();
    assert.equal(res.statusCode, 200);
    assert.deepEqual(order, ["row", "DeleteObjectCommand"]);
    assert.equal(send.mock.calls[0].arguments[0].input.Key, "uploads/1700-abc.mp3");
  } finally {
    db.restore();
    send.mock.restore();
  }
});

test("S3 refusing the delete does not fail it either", async () => {
  const send = mock.method(s3, "send", async () => { throw new Error("AccessDenied"); });
  const db = stubLesson("uploads/1700-abc.mp3");
  try {
    const res = await deleteLesson();
    assert.equal(res.statusCode, 200);
  } finally {
    db.restore();
    send.mock.restore();
  }
});
