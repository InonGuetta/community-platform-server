import "./setup.js";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { s3 } from "../lib/storage.js";
import { env } from "../lib/env.js";
import { ERROR_CODES } from "../lib/AppError.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// Streaming and downloading media that lives in the S3 bucket, through the real
// routes, with S3 itself stood in for (s3.send). The local-file paths are
// covered by sourceViewing.test.js and publicLessons.test.js; these are the
// same routes when the key names a bucket object.

const app = createApp();

const USER = { id: 3, email: "u@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: USER.email, role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });

const withMedia = async (s3Key, mediaType, fn) => {
  const db = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/FROM media_items m/i.test(text)) {
      return { rows: [{ id: 7, title: "שיעור", media_type: mediaType, s3_key: s3Key, is_published: true, course_id: null, uploader_id: 1 }] };
    }
    return { rows: [] };
  });
  try {
    return await fn();
  } finally {
    db.restore();
  }
};

// S3 answering GetObject with `answer(input)`; the inputs it was asked with.
const withBucket = async (answer, fn) => {
  const asked = [];
  const send = mock.method(s3, "send", async (command) => {
    asked.push({ name: command.constructor.name, input: command.input });
    return answer(command.input);
  });
  try {
    return await fn(asked);
  } finally {
    send.mock.restore();
  }
};

const object = (bytes, extra = {}) => ({ Body: Readable.from([Buffer.from(bytes)]), ...extra });
const binary = (res) => Buffer.from(res.body).toString();

const stream = () => request(app).get("/api/media/7/stream").set("Cookie", `token=${token}`);

test("a recording in the bucket streams the range S3 applied, as a 206", async () => {
  await withMedia("uploads/a.mp3", "audio", () => withBucket(
    () => object("2345", { ContentType: "audio/mpeg", ContentLength: 4, ContentRange: "bytes 2-5/10" }),
    async (asked) => {
      const res = await stream().set("Range", "bytes=2-5");
      assert.equal(res.status, 206);
      assert.equal(res.headers["content-range"], "bytes 2-5/10");
      assert.equal(res.headers["content-type"], "audio/mpeg");
      assert.equal(res.headers["accept-ranges"], "bytes");
      assert.equal(binary(res), "2345");
      assert.deepEqual(asked, [{ name: "GetObjectCommand", input: { Bucket: env.s3Bucket, Key: "uploads/a.mp3", Range: "bytes=2-5" } }]);
    }
  ));
});

test("without a Range it streams whole, as a 200, and asks S3 for no range", async () => {
  await withMedia("uploads/a.mp3", "audio", () => withBucket(
    () => object("0123456789", { ContentType: "audio/mpeg", ContentLength: 10 }),
    async (asked) => {
      const res = await stream();
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-length"], "10");
      assert.equal(binary(res), "0123456789");
      assert.equal("Range" in asked[0].input, false);
    }
  ));
});

test("a .txt in the bucket is fetched whole, whatever range was asked, and served as UTF-8", async () => {
  await withMedia("uploads/a.txt", "text", () => withBucket(
    () => object("שלום", { ContentType: "text/plain" }),
    async (asked) => {
      const res = await stream().set("Range", "bytes=0-1");
      assert.equal(res.status, 200);
      assert.equal(res.headers["content-type"], "text/plain; charset=utf-8");
      assert.equal(res.text, "שלום");
      assert.equal("Range" in asked[0].input, false);
    }
  ));
});

test("a Word file in the bucket that is not a real document is the file's problem", async () => {
  await withMedia("uploads/a.docx", "text", () => withBucket(
    () => object("not a zip", { ContentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }),
    async () => {
      const res = await stream().set("Accept", "application/json");
      assert.equal(res.status, 400);
      assert.equal(res.body.code, ERROR_CODES.DOCUMENT_UNREADABLE);
    }
  ));
});

test("an object missing from the bucket is a 404, not a server fault", async () => {
  await withMedia("uploads/gone.mp3", "audio", () => withBucket(
    () => { throw Object.assign(new Error("The specified key does not exist."), { name: "NoSuchKey" }); },
    async () => {
      const res = await stream().set("Accept", "application/json");
      assert.equal(res.status, 404);
      assert.equal(res.body.code, ERROR_CODES.MEDIA_NOT_FOUND);
    }
  ));
});

test("a download from the bucket is an attachment named after the lesson", async () => {
  await withMedia("uploads/a.mp3", "audio", () => withBucket(
    () => object("abc", { ContentType: "audio/mpeg", ContentLength: 3 }),
    async (asked) => {
      const res = await request(app).get("/api/media/7/download").set("Cookie", `token=${token}`);
      assert.equal(res.status, 200);
      assert.match(res.headers["content-disposition"], /^attachment; filename="_____.mp3"; filename\*=UTF-8''/);
      assert.equal(res.headers["content-type"], "audio/mpeg");
      assert.equal(res.headers["content-length"], "3");
      assert.equal(binary(res), "abc");
      assert.deepEqual(asked[0].input, { Bucket: env.s3Bucket, Key: "uploads/a.mp3" });
    }
  ));
});
