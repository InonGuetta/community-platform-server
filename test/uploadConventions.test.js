import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { getMimeType, extensionOf, MEDIA_TYPE_BY_EXT } from "../lib/mediaFormats.js";

// The "local/<name>" convention is a contract between the upload, the streaming
// and download controllers, the delete path and the transcription worker. If it
// drifts, existing media stops resolving with nothing to indicate why.

test("LOCAL_UPLOAD_DIR resolves where every consumer expects", () => {
  const serverRoot = path.resolve(LOCAL_UPLOAD_DIR, "..");
  assert.equal(
    path.resolve(LOCAL_UPLOAD_DIR),
    path.resolve(path.join(serverRoot, "controllers"), "../uploads"),
    "must match what the controllers used to compute for themselves"
  );
  assert.equal(
    path.resolve(LOCAL_UPLOAD_DIR),
    path.resolve(path.join(serverRoot, "queue/workers"), "../../uploads"),
    "must match what the worker used to compute for itself"
  );
});

test("every file already on disk still resolves and still gets a real type", (t) => {
  if (!fs.existsSync(LOCAL_UPLOAD_DIR)) return t.skip("no uploads directory in this environment");
  const files = fs.readdirSync(LOCAL_UPLOAD_DIR).filter((f) => !f.startsWith("."));
  if (files.length === 0) return t.skip("no stored media to check");

  for (const filename of files) {
    // Exactly what the streaming controller does with an s3_key.
    const s3Key = `local/${filename}`;
    const resolved = path.join(LOCAL_UPLOAD_DIR, s3Key.slice("local/".length));
    assert.ok(fs.existsSync(resolved), `${s3Key} should resolve`);
    assert.notEqual(getMimeType(filename), "application/octet-stream", `${filename} should have a known type`);
  }
});

test("extensions are parsed off the end, not by splitting on dots", () => {
  assert.equal(extensionOf("lecture.mp4"), "mp4");
  assert.equal(extensionOf("shiur.MP3"), "mp3", "case is normalised");
  assert.equal(extensionOf("a.b.c.pdf"), "pdf", "only the final extension");
  // split(".").pop() returned the entire filename here, which then became the
  // stored extension.
  assert.equal(extensionOf("myvideo"), "", "no extension means no extension");
  assert.equal(extensionOf(""), "");
  assert.equal(extensionOf(undefined), "");
});

test("a file with no extension cannot be uploaded", () => {
  assert.equal(MEDIA_TYPE_BY_EXT[extensionOf("myvideo")], undefined);
});

test("the accepted formats agree with the types we can serve", () => {
  for (const ext of Object.keys(MEDIA_TYPE_BY_EXT)) {
    assert.notEqual(getMimeType(`f.${ext}`), "application/octet-stream", `${ext} is accepted but has no Content-Type`);
  }
});

test("declared media types are the three the database knows", () => {
  assert.deepEqual([...new Set(Object.values(MEDIA_TYPE_BY_EXT))].sort(), ["audio", "text", "video"]);
});
