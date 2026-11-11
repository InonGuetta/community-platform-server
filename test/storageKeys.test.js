import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LOCAL_UPLOAD_DIR, LOCAL_KEY_PREFIX, isLocalKey, localKeyFor, localNameOf, localPathOf, removeStored, storeFile, s3,
} from "../lib/storage.js";
import { env } from "../lib/env.js";
import { serverSourceFiles } from "./sourceFiles.js";

// Sets (or, for undefined, removes) environment variables for the length of fn.
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

const S3_ON = { AWS_REGION: "eu-west-1", S3_BUCKET: "test-bucket", AWS_ACCESS_KEY_ID: "k", AWS_SECRET_ACCESS_KEY: "s" };
const S3_OFF = { AWS_REGION: undefined, S3_BUCKET: undefined, AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined };

// A real file in the uploads directory, removed afterwards whatever happens.
const withLocalFile = async (contents, fn) => {
  const key = localKeyFor(`__storage-test-${randomUUID()}.mp3`);
  await fs.mkdir(LOCAL_UPLOAD_DIR, { recursive: true });
  await fs.writeFile(localPathOf(key), contents);
  try {
    return await fn(key);
  } finally {
    await fs.rm(localPathOf(key), { force: true });
  }
};

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

// ── Storing a file ──────────────────────────────────────────────────────────

test("without S3 a file is stored where it is, under its local key", async () => {
  const send = mock.method(s3, "send", async () => ({}));
  try {
    await withEnv(S3_OFF, () => withLocalFile("audio", async (key) => {
      assert.equal(await storeFile(key, { folder: "uploads" }), key);
      assert.equal(send.mock.callCount(), 0, "nothing goes to S3");
    }));
  } finally {
    send.mock.restore();
  }
});

// Upload reads the file stream in parts and hands PutObject each part's bytes —
// a Buffer for a small file — so the body is read in whichever shape it comes.
const bodyText = async (body) => {
  if (body instanceof Uint8Array || typeof body === "string") return Buffer.from(body).toString();
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString();
};

test("with S3 a file goes to <folder>/<name> in the bucket, and the local copy stays", async () => {
  const puts = [];
  const send = mock.method(s3, "send", async (command) => {
    // A small file goes up as one PutObject.
    puts.push({ name: command.constructor.name, ...command.input, Body: await bodyText(command.input.Body) });
    return {};
  });
  try {
    await withEnv(S3_ON, () => withLocalFile("the recording", async (key) => {
      const stored = await storeFile(key, { folder: "uploads" });
      assert.equal(stored, `uploads/${localNameOf(key)}`);
      assert.equal(puts.length, 1);
      assert.equal(puts[0].name, "PutObjectCommand");
      assert.equal(puts[0].Bucket, "test-bucket");
      assert.equal(puts[0].Key, stored);
      assert.equal(puts[0].ContentType, "audio/mpeg", "from the extension, by default");
      assert.equal(puts[0].Body, "the recording");
      await fs.stat(localPathOf(key)); // still there: removing it is the caller's call
    }));
  } finally {
    send.mock.restore();
  }
});

test("a caller can name the folder and the content type", async () => {
  const puts = [];
  const send = mock.method(s3, "send", async (command) => {
    puts.push(command.input);
    return {};
  });
  try {
    await withEnv(S3_ON, () => withLocalFile("x", async (key) => {
      const stored = await storeFile(key, { folder: "recordings", contentType: "audio/webm" });
      assert.equal(stored, `recordings/${localNameOf(key)}`);
      assert.equal(puts[0].ContentType, "audio/webm");
    }));
  } finally {
    send.mock.restore();
  }
});

test("an upload S3 refuses rejects, so the caller can clean up", async () => {
  const send = mock.method(s3, "send", async () => { throw new Error("AccessDenied"); });
  try {
    await withEnv(S3_ON, () => withLocalFile("x", async (key) => {
      await assert.rejects(storeFile(key, { folder: "uploads" }), /AccessDenied/);
    }));
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

test("only lib/storage.js uploads to S3", async () => {
  const files = await serverSourceFiles();
  const uploaders = files
    .filter(({ source }) => /@aws-sdk\/lib-storage/.test(source))
    .map(({ file }) => file);
  assert.deepEqual(uploaders, [path.join("lib", "storage.js")], `use storeFile instead: ${uploaders.join(", ")}`);
});
