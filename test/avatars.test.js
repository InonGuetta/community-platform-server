import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { LOCAL_UPLOAD_DIR } from "../lib/storage.js";
import { imageTypeOf } from "../lib/mediaFormats.js";
import { requireAvatarImage } from "../lib/validate.js";
import { AVATAR_MAX_BYTES } from "../services/servicesAvatars.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A profile picture (migration 052): uploaded by its owner, checked by its
// bytes, stored like any other file, replaced and removed with its old file
// deleted, and served to anyone signed in.

const app = createApp();
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const USER = { id: 10, email: "u@example.com", role: "student" };
const cookie = `token=${jwt.sign(USER, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

// The first bytes of each format, padded to look like a file.
const pad = (head) => Buffer.concat([head, Buffer.alloc(64)]);
const PNG = pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const JPEG = pad(Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
const WEBP = pad(Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]));
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

// A file left in the uploads directory, as a previous picture would be.
const givenStored = (name, bytes = PNG) => {
  fs.mkdirSync(LOCAL_UPLOAD_DIR, { recursive: true });
  fs.writeFileSync(path.join(LOCAL_UPLOAD_DIR, name), bytes);
  return `local/${name}`;
};
const storedNamesFor = (userId) =>
  fs.existsSync(LOCAL_UPLOAD_DIR) ? fs.readdirSync(LOCAL_UPLOAD_DIR).filter((f) => f.startsWith(`avatar-${userId}-`)) : [];
const cleanUp = (userId) => {
  for (const f of storedNamesFor(userId)) fs.rmSync(path.join(LOCAL_UPLOAD_DIR, f), { force: true });
};

// The database: the signed-in user, and the avatar UPDATEs answering with the
// previous key the CTE read.
const db = ({ previousKey = null, avatarKey = null } = {}) =>
  stubPoolQuery(pool, (text, params) => {
    if (/FROM users WHERE id=\$1 AND is_active=TRUE/.test(text)) return { rows: [USER] };
    if (/UPDATE users SET avatar_key = \$1/.test(text)) {
      return { rows: [{ previous_key: previousKey, ...USER, avatar_url: params[1] }] };
    }
    if (/UPDATE users SET avatar_key = NULL/.test(text)) {
      return { rows: [{ previous_key: previousKey, ...USER, avatar_url: null }] };
    }
    if (/SELECT avatar_key FROM users/.test(text)) return { rows: avatarKey ? [{ avatar_key: avatarKey }] : [] };
    return { rows: [] };
  });

test("a picture is known by its bytes, not its name", () => {
  assert.equal(imageTypeOf(PNG), "png");
  assert.equal(imageTypeOf(JPEG), "jpg");
  assert.equal(imageTypeOf(WEBP), "webp");
  assert.equal(imageTypeOf(SVG), null, "an SVG can carry script, and is never accepted");
  assert.equal(imageTypeOf(Buffer.from("hello")), null);
  assert.equal(imageTypeOf(null), null);
});

test("the guard wants a picture, and one of the three formats", () => {
  assert.throws(() => requireAvatarImage(undefined), (e) => e.code === "AVATAR_REQUIRED");
  assert.throws(() => requireAvatarImage({ buffer: SVG }), (e) => e.code === "AVATAR_NOT_IMAGE");
  assert.deepEqual(requireAvatarImage({ buffer: JPEG }), { buffer: JPEG, ext: "jpg" });
});

test("uploading stores the picture under a generated name and points avatar_url at it", async () => {
  const stub = db();
  try {
    const res = await request(app).post("/api/auth/me/avatar").set("Cookie", cookie)
      .attach("avatar", PNG, { filename: "../../evil.svg", contentType: "image/svg+xml" });
    assert.equal(res.status, 200);
    assert.match(res.body.avatar_url, /^\/api\/auth\/avatar\/10\?v=\d+$/);
    const update = stub.calls.find((c) => /UPDATE users SET avatar_key = \$1/.test(c.text));
    // Stored as what its bytes are, under a name the request did not choose.
    assert.match(update.params[0], /^local\/avatar-10-\d+\.png$/);
    assert.equal(update.params[2], 10);
    assert.equal(storedNamesFor(10).length, 1);
  } finally {
    stub.restore();
    cleanUp(10);
  }
});

test("something that is not a picture is refused, and nothing is stored", async () => {
  const stub = db();
  try {
    const res = await request(app).post("/api/auth/me/avatar").set("Cookie", cookie)
      .attach("avatar", SVG, { filename: "face.png", contentType: "image/png" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "AVATAR_NOT_IMAGE");
    assert.equal(stub.calls.some((c) => /UPDATE users/.test(c.text)), false);
    assert.equal(storedNamesFor(10).length, 0);

    const none = await request(app).post("/api/auth/me/avatar").set("Cookie", cookie);
    assert.equal(none.body.code, "AVATAR_REQUIRED");
  } finally {
    stub.restore();
  }
});

test("a picture over the limit is refused with the limit to say", async () => {
  const stub = db();
  try {
    const big = Buffer.concat([PNG, Buffer.alloc(AVATAR_MAX_BYTES)]);
    const res = await request(app).post("/api/auth/me/avatar").set("Cookie", cookie)
      .attach("avatar", big, { filename: "big.png" });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, "AVATAR_TOO_LARGE");
    assert.deepEqual(res.body.params, { maxMb: 2 });
  } finally {
    stub.restore();
  }
});

test("a new picture deletes the previous one's file", async () => {
  const previousKey = givenStored("avatar-11-1.png");
  const stub = db({ previousKey });
  try {
    const res = await request(app).post("/api/auth/me/avatar").set("Cookie", cookie)
      .attach("avatar", JPEG, { filename: "new.jpg" });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(LOCAL_UPLOAD_DIR, "avatar-11-1.png")), false);
  } finally {
    stub.restore();
    cleanUp(10);
    cleanUp(11);
  }
});

test("removing clears the avatar and deletes its file", async () => {
  const previousKey = givenStored("avatar-11-2.png");
  const stub = db({ previousKey });
  try {
    const res = await request(app).delete("/api/auth/me/avatar").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.avatar_url, null);
    assert.equal(fs.existsSync(path.join(LOCAL_UPLOAD_DIR, "avatar-11-2.png")), false);
  } finally {
    stub.restore();
    cleanUp(11);
  }
});

test("the picture is served as an image, cached, to anyone signed in — and 404 when there is none", async () => {
  const key = givenStored("avatar-12-3.png");
  let stub = db({ avatarKey: key });
  try {
    const res = await request(app).get("/api/auth/avatar/12").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^image\/png/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["cache-control"], /immutable/);
    assert.equal(Buffer.compare(res.body, PNG), 0);

    const stranger = await request(app).get("/api/auth/avatar/12");
    assert.equal(stranger.status, 401);
  } finally {
    stub.restore();
    cleanUp(12);
  }
  stub = db();
  try {
    assert.equal((await request(app).get("/api/auth/avatar/12").set("Cookie", cookie)).status, 404);
    // A key whose file has gone is a 404, not a 500.
  } finally {
    stub.restore();
  }
  stub = db({ avatarKey: "local/avatar-12-gone.png" });
  try {
    assert.equal((await request(app).get("/api/auth/avatar/12").set("Cookie", cookie)).status, 404);
  } finally {
    stub.restore();
  }
});
