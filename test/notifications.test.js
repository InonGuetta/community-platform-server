import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  notify,
  notifyAdmins,
  notifyProcessingOutcome,
  NOTIFICATION_TYPES,
} from "../services/servicesNotifications.js";
import { notificationEmail } from "../lib/mailer.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Notifications (PRD 6.15, migration 035): one service writes them, the bell
// reads them. What is pinned here:
//
//   · notify() never throws — its callers have already succeeded at something;
//   · it writes nothing for a deactivated account;
//   · the pipeline's outcome goes to the uploader, with a reason only when the
//     reason is the user's to act on;
//   · a role request reaches every admin, from both doors (signup, profile);
//   · every read and mark is scoped to the caller;
//   · the mail escapes what other people typed.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const INSERT = /INSERT INTO notifications/i;

// ── notify ──────────────────────────────────────────────────────────────────

test("notify stores the type and the payload for that user, only if active", async () => {
  const stub = stubPoolQuery(pool, (text) => (INSERT.test(text) ? { rows: [{ id: 1, email: null }] } : { rows: [] }));
  try {
    assert.equal(await notify(5, NOTIFICATION_TYPES.PROCESSING_DONE, { mediaId: 9, title: "שיעור" }), true);
    const [call] = stub.calls;
    assert.match(call.text, INSERT);
    assert.match(call.text, /is_active = TRUE/, "a deactivated account is told nothing");
    assert.deepEqual(call.params, [5, "processing_done", JSON.stringify({ mediaId: 9, title: "שיעור" })]);
  } finally {
    stub.restore();
  }
});

test("notify reports false when the user is missing or inactive", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await notify(5, NOTIFICATION_TYPES.ROLE_REQUEST, {}), false);
  } finally {
    stub.restore();
  }
});

// Its callers are a saved role request and a finished transcript. A throw would
// turn the first into a 500 and send the second back to Bull.
test("notify never throws, even when the database does", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("connection refused");
  });
  try {
    assert.equal(await notify(5, NOTIFICATION_TYPES.ROLE_REQUEST, {}), false);
    assert.equal(await notifyAdmins(NOTIFICATION_TYPES.ROLE_REQUEST, {}), 0);
    assert.equal(await notifyProcessingOutcome(9, { ok: true }), false);
  } finally {
    stub.restore();
  }
});

test("notifyAdmins writes one row per active admin", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/role = 'admin'/.test(text)) return { rows: [{ id: 1 }, { id: 2 }] };
    if (INSERT.test(text)) return { rows: [{ id: 99, email: null }] };
    return { rows: [] };
  });
  try {
    assert.equal(await notifyAdmins(NOTIFICATION_TYPES.ROLE_REQUEST, { requestedRole: "lecturer" }), 2);
    const inserts = stub.calls.filter((c) => INSERT.test(c.text));
    assert.deepEqual(inserts.map((c) => c.params[0]).sort(), [1, 2]);
  } finally {
    stub.restore();
  }
});

// ── The pipeline's outcome ──────────────────────────────────────────────────

const pipelineStub = () =>
  stubPoolQuery(pool, (text) => {
    if (/FROM media_items/.test(text)) return { rows: [{ uploader_id: 4, title: "פרשת השבוע", media_type: "audio" }] };
    if (INSERT.test(text)) return { rows: [{ id: 1, email: null }] };
    return { rows: [] };
  });

test("a finished pipeline notifies the uploader", async () => {
  const stub = pipelineStub();
  try {
    assert.equal(await notifyProcessingOutcome(9, { ok: true }), true);
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.equal(insert.params[0], 4);
    assert.equal(insert.params[1], "processing_done");
    assert.deepEqual(JSON.parse(insert.params[2]), { mediaId: 9, title: "פרשת השבוע", mediaType: "audio" });
  } finally {
    stub.restore();
  }
});

test("a failure carries the reason only when there is one to give", async () => {
  let stub = pipelineStub();
  try {
    await notifyProcessingOutcome(9, { ok: false, reason: "לא נמצא טקסט קריא בקובץ." });
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.equal(insert.params[1], "processing_error");
    assert.equal(JSON.parse(insert.params[2]).reason, "לא נמצא טקסט קריא בקובץ.");
  } finally {
    stub.restore();
  }
  stub = pipelineStub();
  try {
    await notifyProcessingOutcome(9, { ok: false });
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.equal("reason" in JSON.parse(insert.params[2]), false);
  } finally {
    stub.restore();
  }
});

// Structural, because the workers cannot be run here (Bull, ffmpeg, OpenAI).
// What it guards: the outcome is announced where the status is FINAL — after
// 'done', and in the final-attempt branch of each catch — never per retry.
test("both workers announce the outcome where the status becomes final", async () => {
  const { readFile } = await import("fs/promises");
  const llm = await readFile(new URL("../queue/workers/llmWorker.js", import.meta.url), "utf8");
  const tx = await readFile(new URL("../queue/workers/transcriptionWorker.js", import.meta.url), "utf8");

  const doneAt = llm.indexOf("status='done'");
  const okAt = llm.indexOf("notifyProcessingOutcome(mediaId, { ok: true })");
  assert.ok(doneAt > 0 && okAt > doneAt, "llmWorker: 'done' is announced after it is written");

  const finalAt = llm.indexOf("if (!finalAttempt)");
  const failAt = llm.indexOf("notifyProcessingOutcome(mediaId, { ok: false");
  assert.ok(finalAt > 0 && failAt > finalAt, "llmWorker: a failure is announced only past the retry check");

  const txFinal = tx.indexOf("job.attemptsMade + 1 >= attemptsAllowed");
  const txFail = tx.indexOf("notifyProcessingOutcome(mediaId, { ok: false })");
  assert.ok(txFinal > 0 && txFail > txFinal, "transcriptionWorker: inside the final-attempt branch");
});

// ── The mail ────────────────────────────────────────────────────────────────

test("every type is worded, and an unknown one is not mailed", () => {
  for (const type of Object.values(NOTIFICATION_TYPES)) {
    const message = notificationEmail(type, { title: "ש", mediaId: 1, requestedRole: "lecturer", displayName: "א" });
    assert.ok(message?.subject && message.text && message.html, `no wording for ${type}`);
  }
  assert.equal(notificationEmail("no_such_type", {}), null);
});

test("what other people typed reaches the mail as text, not markup", () => {
  const message = notificationEmail("role_request", {
    displayName: '<a href="https://evil.example">לחץ</a>',
    requestedRole: "lecturer",
  });
  assert.doesNotMatch(message.html, /<a href="https:\/\/evil/);
  assert.match(message.html, /&lt;a href=&quot;https:\/\/evil/);
});

// ── The routes ──────────────────────────────────────────────────────────────

const session = (role, id = 7) => {
  const row = { id, email: "u@example.com", role };
  return { row, cookie: `token=${jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
};

test("the bell reads only the caller's notifications, with the unread count", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/.test(text) && !/approval_status/.test(text)) return { rows: [row] };
    if (/COUNT\(\*\)::int AS count FROM notifications/.test(text)) return { rows: [{ count: 2 }] };
    if (/FROM notifications/.test(text)) return { rows: [{ id: 1, type: "processing_done", payload: {}, read_at: null }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.unread, 2);
    assert.equal(res.body.items.length, 1);
    assert.equal("pendingRoleRequests" in res.body, false, "a student is not told about role requests");
    for (const call of stub.calls.filter((c) => /notifications/.test(c.text))) {
      assert.match(call.text, /user_id = \$1/);
      assert.equal(call.params[0], 7);
    }
  } finally {
    stub.restore();
  }
});

test("an admin's bell also counts the waiting role requests", async () => {
  const { row, cookie } = session("admin", 1);
  const stub = stubPoolQuery(pool, (text) => {
    if (/approval_status = 'pending'/.test(text)) return { rows: [{ count: 3 }] };
    if (/FROM users/.test(text)) return { rows: [row] };
    if (/COUNT/.test(text)) return { rows: [{ count: 0 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/notifications").set("Cookie", cookie);
    assert.equal(res.body.pendingRoleRequests, 3);
  } finally {
    stub.restore();
  }
});

test("marking another user's notification answers 404", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/.test(text)) return { rows: [row] };
    if (/UPDATE notifications/.test(text)) return { rows: [], rowCount: 0 };
    return { rows: [] };
  });
  try {
    const res = await request(app).post("/api/notifications/55/read").set("Cookie", cookie);
    assert.equal(res.status, 404);
    const update = stub.calls.find((c) => /UPDATE notifications/.test(c.text));
    assert.match(update.text, /user_id = \$2/);
    assert.equal(Number(update.params[0]), 55);
    assert.equal(update.params[1], 7, "looked up together with the caller");
  } finally {
    stub.restore();
  }
});

test("read-all is not mistaken for an id", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => (/FROM users/.test(text) ? { rows: [row] } : { rows: [], rowCount: 0 }));
  try {
    const res = await request(app).post("/api/notifications/read-all").set("Cookie", cookie);
    assert.equal(res.status, 204);
  } finally {
    stub.restore();
  }
});

// ── REG-11: a role request reaches the admins ───────────────────────────────

test("asking for a role from the profile notifies every admin", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/role = 'admin'/.test(text)) return { rows: [{ id: 1 }] };
    if (INSERT.test(text)) return { rows: [{ id: 1, email: null }] };
    if (/UPDATE users SET/.test(text)) {
      return { rows: [{ id: 7, email: "u@example.com", role: "student", display_name: "דוד", requested_role: "lecturer", approval_status: "pending" }] };
    }
    if (/SELECT role, approval_status/.test(text)) return { rows: [{ role: "student", approval_status: "approved", requested_role: null }] };
    if (/FROM users/.test(text)) return { rows: [row] };
    return { rows: [] };
  });
  try {
    const res = await request(app).post("/api/auth/request-role").set("Cookie", cookie).send({ requestedRole: "lecturer" });
    assert.equal(res.status, 200);
    // Not awaited by the handler — give the fire-and-forget a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.ok(insert, "no notification was written");
    assert.equal(insert.params[0], 1);
    assert.equal(insert.params[1], "role_request");
    assert.equal(JSON.parse(insert.params[2]).requestedRole, "lecturer");
  } finally {
    stub.restore();
  }
});

test("a student signing up asks for nothing, and no admin is told", async () => {
  const stub = stubPoolQuery(pool, (text) => {
    if (/INSERT INTO users/.test(text)) {
      return { rows: [{ id: 8, email: "s@example.com", role: "student", display_name: null, requested_role: "student", approval_status: "approved" }] };
    }
    return { rows: [] };
  });
  try {
    const res = await request(app).post("/api/auth/register").send({ email: "s@example.com", password: "a-long-enough-password-1" });
    assert.equal(res.status, 201, res.text);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stub.calls.some((c) => INSERT.test(c.text)), false);
  } finally {
    stub.restore();
  }
});
