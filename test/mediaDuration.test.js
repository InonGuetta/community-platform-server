import "./setup.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import jwt from "jsonwebtoken";
import ffmpegPath from "ffmpeg-static";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { parseDurationSeconds, probeDurationSeconds } from "../lib/mediaDuration.js";
import { setDurationIfMissing } from "../services/servicesMedia.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A recording's length: read from the file's header by the bundled ffmpeg, at
// upload and again in the transcription worker. The column it fills had been in
// the schema since migration 002 with nothing ever writing it.
//
// The probe is run against REAL files here, made by the same ffmpeg binary, so
// what is tested is the binary's actual output and not a guess at its shape.

// ── Reading ffmpeg's header line ────────────────────────────────────────────

test("reads hours, minutes and seconds into whole seconds", () => {
  assert.equal(parseDurationSeconds("  Duration: 00:00:03.00, start: 0.000000, bitrate: 64 kb/s"), 3);
  assert.equal(parseDurationSeconds("Duration: 01:12:34.40, start: 0"), 4354);
  assert.equal(parseDurationSeconds("Duration: 10:00:00.00"), 36000);
});

// A filter boundary is a minute mark, so the nearer whole second is the honest one.
test("rounds to the nearer second rather than cutting the fraction off", () => {
  assert.equal(parseDurationSeconds("Duration: 00:00:59.60"), 60);
  assert.equal(parseDurationSeconds("Duration: 00:00:59.40"), 59);
});

test("finds the line among everything else ffmpeg prints", () => {
  const stderr = [
    "Input #0, mp3, from 'shiur.mp3':",
    "  Metadata:",
    "    title           : שיעור",
    "  Duration: 00:42:07.12, start: 0.025057, bitrate: 128 kb/s",
    "  Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 128 kb/s",
    "At least one output file must be specified",
  ].join("\n");
  assert.equal(parseDurationSeconds(stderr), 2527);
});

test("answers null when the header has no length to give", () => {
  assert.equal(parseDurationSeconds("  Duration: N/A, bitrate: N/A"), null);
  assert.equal(parseDurationSeconds("Duration: 00:00:00.00"), null);
  assert.equal(parseDurationSeconds("shiur.mp3: Invalid data found when processing input"), null);
  assert.equal(parseDurationSeconds(""), null);
  assert.equal(parseDurationSeconds(undefined), null);
});

// ── Probing real files ──────────────────────────────────────────────────────

let workDir;
let threeSecondMp3;
let fiveSecondMp4;

before(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), "duration-test-"));
  threeSecondMp3 = path.join(workDir, "three.mp3");
  fiveSecondMp4 = path.join(workDir, "five.mp4");
  // A tone and a blank picture, generated rather than checked in: nothing in
  // the repository has to hold a binary fixture, and the files are whatever
  // this exact ffmpeg build writes.
  const make = (args) => {
    const run = spawnSync(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", ...args]);
    assert.equal(run.status, 0, `could not make a fixture: ${run.stderr}`);
  };
  make(["-f", "lavfi", "-i", "sine=frequency=440:duration=3", threeSecondMp3]);
  make([
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=5",
    "-f", "lavfi", "-i", "sine=duration=5",
    "-shortest", "-pix_fmt", "yuv420p", fiveSecondMp4,
  ]);
});

after(async () => {
  fs.rmSync(workDir, { recursive: true, force: true });
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

test("measures an audio file", async () => {
  assert.equal(await probeDurationSeconds(threeSecondMp3), 3);
});

test("measures a video file", async () => {
  assert.equal(await probeDurationSeconds(fiveSecondMp4), 5);
});

// Never fatal: every one of these must answer null, not throw.
test("a missing file, a file that is not media, and no path at all are null", async () => {
  const notMedia = path.join(workDir, "notes.mp3");
  fs.writeFileSync(notMedia, "this is not an mp3");
  assert.equal(await probeDurationSeconds(path.join(workDir, "nope.mp3")), null);
  assert.equal(await probeDurationSeconds(notMedia), null);
  assert.equal(await probeDurationSeconds(""), null);
});

// ── Writing it only where it is missing ─────────────────────────────────────

test("a length is written only to a recording that has none yet", async () => {
  let sent;
  const stub = stubPoolQuery(pool, (text, params) => {
    sent = { text, params };
    return { rows: [{ id: 12 }] };
  });
  try {
    assert.equal(await setDurationIfMissing(12, 180), true);
    assert.match(sent.text, /duration_seconds IS NULL/);
    assert.match(sent.text, /media_type <> 'text'/);
    assert.deepEqual(sent.params, [12, 180]);
  } finally {
    stub.restore();
  }
});

test("no usable length asks the database nothing", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("a missing length reached the database");
  });
  try {
    assert.equal(await setDurationIfMissing(12, null), false);
    assert.equal(await setDurationIfMissing(12, 0), false);
    assert.equal(await setDurationIfMissing(12, 2.5), false);
  } finally {
    stub.restore();
  }
});

// ── At upload ───────────────────────────────────────────────────────────────
//
// Through the real router, multer and controller. S3 is not configured in the
// tests, so the file stays in the local upload directory and is removed after.

const app = createApp();
const lecturer = () => {
  const row = { id: 7, email: "u@example.com", role: "lecturer" };
  return { token: jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" }), row };
};

const uploadCapturingInsert = async ({ file, mediaType }) => {
  const { token, row } = lecturer();
  let inserted = null;
  let call = 0;
  const stub = stubPoolQuery(pool, (text, params) => {
    if (call++ === 0) return { rows: [row] };
    if (/INSERT INTO media_items/.test(text)) {
      inserted = params;
      return { rows: [{ id: 99, media_type: mediaType, s3_key: params[4], title: params[1] }] };
    }
    return { rows: [] };
  });
  try {
    const res = await request(app)
      .post("/api/media/upload")
      .set("Cookie", `token=${token}`)
      .field("title", "שיעור")
      .field("mediaType", mediaType)
      .attach("file", file);
    return { res, inserted };
  } finally {
    stub.restore();
    // The stored copy, named by multer — read back from the INSERT.
    const s3Key = inserted?.[4];
    if (s3Key?.startsWith("local/")) {
      fs.rmSync(path.join(LOCAL_UPLOAD_DIR, s3Key.slice("local/".length)), { force: true });
    }
  }
};

test("an uploaded recording is stored with its length", async () => {
  const { res, inserted } = await uploadCapturingInsert({ file: threeSecondMp3, mediaType: "audio" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.ok(inserted, "the upload reached the INSERT");
  // createMedia's column order: uploader, title, description, type, key, DURATION.
  assert.equal(inserted[5], 3);
});

test("an uploaded document is stored with no length, and is not probed", async () => {
  const txt = path.join(workDir, "book.txt");
  fs.writeFileSync(txt, "ספר");
  const { res, inserted } = await uploadCapturingInsert({ file: txt, mediaType: "text" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(inserted[5], null);
});

// The file is the thing of value; an unreadable header must not cost it.
test("a recording whose length cannot be read still uploads, with no length", async () => {
  const broken = path.join(workDir, "broken.mp3");
  fs.writeFileSync(broken, "not really audio");
  const { res, inserted } = await uploadCapturingInsert({ file: broken, mediaType: "audio" });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(inserted[5], null);
});
