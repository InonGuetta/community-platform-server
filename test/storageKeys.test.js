import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LOCAL_UPLOAD_DIR, LOCAL_KEY_PREFIX, isLocalKey, localKeyFor, localNameOf, localPathOf, removeStored, s3,
} from "../lib/storage.js";
import { env } from "../lib/env.js";
import { serverSourceFiles } from "./sourceFiles.js";

// lib/storage.js owns the s3_key convention: "local/<name>" is a file in
// LOCAL_UPLOAD_DIR, anything else an object in the S3 bucket.

test("the prefix is the one stored in the database's rows", () => {
  // Every media_items and session_recordings row written so far carries it;
  // changing it here would make all of them unreadable.
  assert.equal(LOCAL_KEY_PREFIX, "local/");
});

test("a local key is told apart from an S3 key", () => {
  assert.equal(isLocalKey("local/1700-abc.mp4"), true);
  assert.equal(isLocalKey("uploads/1700-abc.mp4"), false);
  assert.equal(isLocalKey("recordings/session-1-recording-2.webm"), false);
  assert.equal(isLocalKey(null), false);
  assert.equal(isLocalKey(undefined), false);
});

test("a name, its key and its path agree", () => {
  const key = localKeyFor("1700-abc.mp4");
  assert.equal(key, "local/1700-abc.mp4");
  assert.equal(localNameOf(key), "1700-abc.mp4");
  assert.equal(localPathOf(key), path.join(LOCAL_UPLOAD_DIR, "1700-abc.mp4"));
});

test("removeStored deletes a local file", async () => {
  const name = `__storage-test-${randomUUID()}.txt`;
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(LOCAL_UPLOAD_DIR, name), "x");
  await removeStored(localKeyFor(name));
  await assert.rejects(fs.stat(path.join(LOCAL_UPLOAD_DIR, name)), { code: "ENOENT" });
});

test("a local file already gone is an error, unless missingOk", async () => {
  const key = localKeyFor(`__storage-test-${randomUUID()}.txt`);
  await assert.rejects(removeStored(key), { code: "ENOENT" });
  await removeStored(key, { missingOk: true });
});

test("removeStored deletes an S3 object from the configured bucket", async () => {
  const send = mock.method(s3, "send", async () => ({}));
  try {
    await removeStored("uploads/1700-abc.mp4");
    assert.equal(send.mock.callCount(), 1);
    const command = send.mock.calls[0].arguments[0];
    assert.equal(command.constructor.name, "DeleteObjectCommand");
    assert.deepEqual(command.input, { Bucket: env.s3Bucket, Key: "uploads/1700-abc.mp4" });
  } finally {
    send.mock.restore();
  }
});

test("an S3 failure reaches the caller, who decides what to log", async () => {
  const send = mock.method(s3, "send", async () => { throw new Error("AccessDenied"); });
  try {
    await assert.rejects(removeStored("uploads/x.mp4"), /AccessDenied/);
  } finally {
    send.mock.restore();
  }
});

// ── "local/" is spelled out once ────────────────────────────────────────────

const isComment = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

test("no server module but lib/storage.js spells out the local/ prefix", async () => {
  const files = await serverSourceFiles();
  assert.ok(files.length > 50, `only ${files.length} source files found`);
  const offending = [];
  for (const { file, source } of files) {
    if (file === path.join("lib", "storage.js")) continue;
    source.split(/\r?\n/).forEach((line, i) => {
      if (/local\//.test(line) && !isComment(line)) offending.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offending, [], `use isLocalKey / localKeyFor / localPathOf instead: ${offending.join(", ")}`);
});
