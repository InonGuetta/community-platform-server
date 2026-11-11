import "./setup.js";
import test, { after, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { isLocalKey, localKeyFor, localPathOf, s3 } from "../lib/storage.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

const app = createApp();

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// Where an upload ends up, through the real route: multer writes the file into
// the uploads directory, and createMedia either leaves it there (no S3) or
// copies it to the bucket and drops the local copy once the row exists. A
// failure after the copy removes BOTH copies — nothing is left that no row
// points at.

const S3_ON = { AWS_REGION: "eu-west-1", S3_BUCKET: "test-bucket", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
const S3_OFF = { AWS_REGION: undefined, S3_BUCKET: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined };

const withEnv = async (vars, fn) => {
  const saved = Object.fromEntries(Object.keys(vars).map((name) => [name, process.env[name]]));
  const assign = (values) => {
    for (const [name, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
  assign(vars);
  try {
    return await fn();
  } finally {
    assign(saved);
  }
};

const LECTURER = { id: 7, email: "u@example.com", role: "lecturer" };
const token = jwt.sign(LECTURER, process.env.JWT_SECRET, { expiresIn: "1h" });

const book = path.join(os.tmpdir(), `upload-test-${process.pid}.txt`);
fs.writeFileSync(book, "ספר");
after(() => fs.rmSync(book, { force: true }));

// Uploads the document; `insert` decides what the INSERT answers (or throws).
// Returns the response and the key the INSERT was given.
const upload = async (insert) => {
  let storedKey = null;
  let call = 0;
  const db = stubPoolQuery(pool, (text, params) => {
    if (call++ === 0) return { rows: [LECTURER] }; // verifyToken's user lookup
    if (/INSERT INTO media_items/.test(text)) {
      storedKey = params[4];
      return insert(params);
    }
    return { rows: [] };
  });
  try {
    const res = await request(app)
      .post("/api/media/upload")
      .set("Cookie", `token=${token}`)
      .field("title", "ספר")
      .field("mediaType", "text")
      .attach("file", book);
    return { res, storedKey };
  } finally {
    db.restore();
  }
};

const created = (params) => ({ rows: [{ id: 99, media_type: "text", s3_key: params[4], title: params[1] }] });

test("without S3 the upload stays on disk, under its local key", async () => {
  const { res, storedKey } = await withEnv(S3_OFF, () => upload(created));
  try {
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(isLocalKey(storedKey), storedKey);
    assert.ok(fs.existsSync(localPathOf(storedKey)), "the file the row points at is there");
  } finally {
    if (isLocalKey(storedKey)) fs.rmSync(localPathOf(storedKey), { force: true });
  }
});

test("with S3 the upload goes to uploads/<name>, and the local copy goes once the row exists", async () => {
  const sent = [];
  const send = mock.method(s3, "send", async (command) => { sent.push(command); return {}; });
  try {
    const { res, storedKey } = await withEnv(S3_ON, () => upload(created));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.match(storedKey, /^uploads\/[^/]+\.txt$/);
    const put = sent.find((c) => c.constructor.name === "PutObjectCommand");
    assert.equal(put?.input.Key, storedKey);
    assert.equal(put?.input.ContentType, "text/plain");
    const name = storedKey.slice("uploads/".length);
    assert.equal(fs.existsSync(localPathOf(localKeyFor(name))), false, "no second copy left on disk");
  } finally {
    send.mock.restore();
  }
});

test("with S3, a row that fails to save takes the uploaded object and the local file with it", async () => {
  const sent = [];
  const send = mock.method(s3, "send", async (command) => { sent.push(command); return {}; });
  try {
    const { res, storedKey } = await withEnv(S3_ON, () => upload(() => { throw new Error("db down"); }));
    assert.equal(res.status, 500);
    const names = sent.map((c) => c.constructor.name);
    assert.deepEqual(names.filter((n) => n !== "PutObjectCommand"), ["DeleteObjectCommand"]);
    assert.equal(sent.find((c) => c.constructor.name === "DeleteObjectCommand").input.Key, storedKey);
    const name = storedKey.slice("uploads/".length);
    assert.equal(fs.existsSync(localPathOf(localKeyFor(name))), false, "the local file is gone too");
  } finally {
    send.mock.restore();
  }
});
