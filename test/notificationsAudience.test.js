import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  deliver,
  notifySessionAudience,
  sendDueSessionReminders,
  notifyNewLesson,
  categoryOf,
  NOTIFICATION_TYPES,
  EMAIL_CATEGORIES,
} from "../services/servicesNotifications.js";
import { becameVisibleToCourse } from "../controllers/controllersMedia.js";
import { signUnsubscribeToken, readUnsubscribeToken } from "../lib/unsubscribe.js";
import { notificationEmail } from "../lib/mailer.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Prompt 5 of the plan: who hears about sessions and new lessons, the
// calendar file, preferences and unsubscribing (PRD NOTIF-2/3/6/8, LIVE-6).

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const INSERT = /INSERT INTO notifications/i;
const inserted = (params) => ({ rows: params[0].map((id) => ({ user_id: id, email: null, mail: false })) });

const session = (role, id = 7) => {
  const row = { id, email: "u@example.com", role };
  return { row, cookie: `token=${jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
};

// ── deliver: the one writer ─────────────────────────────────────────────────

test("deliver skips the mail for an opted-out category or 'all', in the same statement", async () => {
  const stub = stubPoolQuery(pool, (text, params) => (INSERT.test(text) ? inserted(params) : { rows: [] }));
  try {
    await deliver([1, 2], NOTIFICATION_TYPES.NEW_LESSON, { mediaId: 3 });
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.match(insert.text, /notification_email_optouts/);
    assert.match(insert.text, /o\.category IN \(\$4::text, 'all'\)/);
    assert.equal(insert.params[3], "new_lessons");
  } finally {
    stub.restore();
  }
});

test("with onceBy, somebody who already has it for the same value is skipped", async () => {
  const stub = stubPoolQuery(pool, (text, params) => (INSERT.test(text) ? inserted(params) : { rows: [] }));
  try {
    await deliver([1], NOTIFICATION_TYPES.NEW_LESSON, { mediaId: 3 }, { onceBy: "mediaId" });
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.match(insert.text, /NOT EXISTS \(\s*SELECT 1 FROM notifications n/);
    assert.deepEqual(insert.params.slice(4), ["mediaId", "3"]);
  } finally {
    stub.restore();
  }
});

test("an empty audience writes nothing and queries nothing", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await deliver([], NOTIFICATION_TYPES.SESSION_STARTING, {}), 0);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("every type has a category and a mail wording", () => {
  for (const type of Object.values(NOTIFICATION_TYPES)) {
    assert.ok(categoryOf(type), `${type} has no category, so its mail could never be turned off`);
    const message = notificationEmail(type, { title: "ש", mediaId: 1, requestedRole: "lecturer", startsAt: "2026-11-03T17:30:00Z" });
    assert.ok(message?.subject && message.text, `${type} has no wording`);
  }
  for (const [key, category] of Object.entries(EMAIL_CATEGORIES)) {
    assert.ok(category.roles.length > 0, `${key} reaches nobody`);
  }
});

// ── Sessions ────────────────────────────────────────────────────────────────

const sessionStub = (students = [{ id: 11 }, { id: 12 }]) =>
  stubPoolQuery(pool, (text, params) => {
    if (/FROM live_sessions s\s+LEFT JOIN users/.test(text)) {
      return { rows: [{ id: 4, host_id: 2, title: "שיעור ערב", host_name: "הרב לוי", starts_at: new Date("2026-11-03T17:30:00Z") }] };
    }
    if (/FROM courses c JOIN enrollments e/.test(text)) return { rows: students };
    if (INSERT.test(text)) return inserted(params);
    return { rows: [] };
  });

test("a session is announced to the host's students, with when it starts", async () => {
  const stub = sessionStub();
  try {
    assert.equal(await notifySessionAudience(4, NOTIFICATION_TYPES.SESSION_SCHEDULED), 2);
    const audience = stub.calls.find((c) => /FROM courses c JOIN enrollments e/.test(c.text));
    assert.match(audience.text, /c\.lecturer_id = \$1/);
    assert.match(audience.text, /e\.student_id <> \$1/, "the host is not told about their own session");
    assert.deepEqual(audience.params, [2]);
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.deepEqual(JSON.parse(insert.params[2]), {
      sessionId: 4, title: "שיעור ערב", hostName: "הרב לוי", startsAt: "2026-11-03T17:30:00.000Z",
    });
  } finally {
    stub.restore();
  }
});

// D8: a session held for a course is announced to THAT course, not to every
// course its host teaches.
test("a session held for a course is announced to that course's students", async () => {
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM live_sessions s\s+LEFT JOIN users/.test(text)) {
      return { rows: [{ id: 4, host_id: 2, title: "שיעור ערב", host_name: "הרב לוי", starts_at: null, course_id: 9, course_title: "גמרא" }] };
    }
    if (/FROM enrollments WHERE course_id = \$1/.test(text)) return { rows: [{ id: 31 }] };
    if (/FROM courses c JOIN enrollments e/.test(text)) throw new Error("asked for the host's students");
    if (INSERT.test(text)) return inserted(params);
    return { rows: [] };
  });
  try {
    assert.equal(await notifySessionAudience(4, NOTIFICATION_TYPES.SESSION_STARTING), 1);
    const enrolled = stub.calls.find((c) => /FROM enrollments WHERE course_id/.test(c.text));
    assert.deepEqual(enrolled.params, [9, 2], "that course, minus the host");
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.equal(JSON.parse(insert.params[2]).courseTitle, "גמרא");
  } finally {
    stub.restore();
  }
});

test("a lecturer cannot hold a session for another lecturer's course", async () => {
  const lecturer = { id: 7, email: "u@example.com", role: "lecturer" };
  const lecturerCookie = `token=${jwt.sign(lecturer, process.env.JWT_SECRET, { expiresIn: "1h" })}`;
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/.test(text) && !/courses/.test(text)) return { rows: [lecturer] };
    if (/FROM courses c/.test(text)) return { rows: [{ id: 9, lecturer_id: 99, title: "של אחר" }] };
    if (/INSERT INTO live_sessions/.test(text)) throw new Error("the session was created");
    return { rows: [] };
  });
  try {
    const res = await request(app).post("/api/sessions/create").set("Cookie", lecturerCookie)
      .send({ title: "מפגש", sessionType: "group", courseId: 9 });
    assert.equal(res.status, 403);
  } finally {
    stub.restore();
  }
});

test("a host with no students announces to nobody", async () => {
  const stub = sessionStub([]);
  try {
    assert.equal(await notifySessionAudience(4, NOTIFICATION_TYPES.SESSION_STARTING), 0);
    assert.equal(stub.calls.some((c) => INSERT.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

// The claim is what makes the reminder go out exactly once, across restarts
// and across several servers.
test("reminders claim their sessions in the same UPDATE that finds them", async () => {
  const stub = stubPoolQuery(pool, (text) => (/UPDATE live_sessions SET reminder_sent_at/.test(text) ? { rows: [] } : { rows: [] }));
  try {
    assert.equal(await sendDueSessionReminders(), 0);
    const [claim] = stub.calls;
    assert.match(claim.text, /UPDATE live_sessions SET reminder_sent_at = NOW\(\)/);
    assert.match(claim.text, /reminder_sent_at IS NULL/);
    assert.match(claim.text, /started_at IS NULL/, "a session already open is not reminded");
    assert.match(claim.text, /scheduled_at AT TIME ZONE 'UTC'/, "compared as a real instant");
    assert.match(claim.text, /RETURNING id/);
  } finally {
    stub.restore();
  }
});

test("a scheduled session can be downloaded as a calendar file", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM live_sessions s\s+LEFT JOIN users/.test(text)) {
      return { rows: [{ id: 4, host_id: 2, title: "שיעור ערב", host_name: "הרב לוי", starts_at: new Date("2026-11-03T17:30:00Z") }] };
    }
    if (/FROM users/.test(text)) return { rows: [row] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/sessions/4/calendar.ics").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /text\/calendar/);
    assert.match(res.headers["content-disposition"], /session-4\.ics/);
    assert.match(res.text, /DTSTART:20261103T173000Z/);
  } finally {
    stub.restore();
  }
});

test("a session with no time has no calendar file", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM live_sessions s\s+LEFT JOIN users/.test(text)) return { rows: [{ id: 4, host_id: 2, starts_at: null }] };
    if (/FROM users/.test(text)) return { rows: [row] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/sessions/4/calendar.ics").set("Cookie", cookie);
    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

// ── A new lesson ────────────────────────────────────────────────────────────

test("an edit that puts a lesson in front of its course's students is news", () => {
  const draft = { is_published: false, course_id: 5 };
  const live = { is_published: true, course_id: 5 };
  assert.equal(becameVisibleToCourse(draft, live), true, "published while in the course");
  assert.equal(becameVisibleToCourse({ is_published: true, course_id: null }, live), true, "moved into the course while published");
  assert.equal(becameVisibleToCourse({ is_published: true, course_id: 6 }, live), true, "moved from another course");
  assert.equal(becameVisibleToCourse(live, live), false, "a title fix on a published lesson is not");
  assert.equal(becameVisibleToCourse(live, { is_published: false, course_id: 5 }), false, "unpublishing is not");
  assert.equal(becameVisibleToCourse(draft, { is_published: true, course_id: null }), false, "the general library has no course to tell");
});

test("a new lesson goes to the course's students, not its uploader, once each", async () => {
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM media_items m JOIN courses c/.test(text)) {
      return { rows: [{ id: 3, title: "דף ב", media_type: "audio", creator_name: "הרב", uploader_id: 2, course_id: 5, is_published: true, course_title: "גמרא" }] };
    }
    if (/FROM enrollments/.test(text)) return { rows: [{ student_id: 11 }, { student_id: 12 }] };
    if (INSERT.test(text)) return inserted(params);
    return { rows: [] };
  });
  try {
    assert.equal(await notifyNewLesson(3), 2);
    const enrolled = stub.calls.find((c) => /FROM enrollments/.test(c.text));
    assert.deepEqual(enrolled.params, [5, 2]);
    const insert = stub.calls.find((c) => INSERT.test(c.text));
    assert.equal(insert.params[1], "new_lesson");
    assert.deepEqual(insert.params.slice(4), ["mediaId", "3"]);
  } finally {
    stub.restore();
  }
});

test("an unpublished lesson tells nobody", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM media_items m JOIN courses c/.test(text) ? { rows: [{ id: 3, course_id: 5, is_published: false }] } : { rows: [] }
  );
  try {
    assert.equal(await notifyNewLesson(3), 0);
    assert.equal(stub.calls.some((c) => INSERT.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

// ── Preferences and unsubscribing ───────────────────────────────────────────

test("a token names its user and category, and nothing else reads as one", () => {
  const token = signUnsubscribeToken(7, "sessions");
  assert.deepEqual(readUnsubscribeToken(token), { userId: 7, category: "sessions" });
  // A session cookie is signed with JWT_SECRET itself, and must not unsubscribe.
  const cookieToken = jwt.sign({ id: 7, role: "student" }, process.env.JWT_SECRET);
  assert.equal(readUnsubscribeToken(cookieToken), null);
  assert.equal(readUnsubscribeToken("nonsense"), null);
  assert.equal(readUnsubscribeToken(undefined), null);
});

test("the unsubscribe link works with no session, and only for its own user", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).post("/api/notifications/unsubscribe").send({ token: signUnsubscribeToken(7, "sessions") });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { category: "sessions" });
    const write = stub.calls.find((c) => /INSERT INTO notification_email_optouts/.test(c.text));
    assert.deepEqual(write.params, [7, "sessions"]);
  } finally {
    stub.restore();
  }
});

test("'all' from the unsubscribe page turns off every category", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).post("/api/notifications/unsubscribe").send({ token: signUnsubscribeToken(7, "sessions"), all: true });
    assert.deepEqual(res.body, { category: "all" });
    assert.deepEqual(stub.calls.find((c) => /notification_email_optouts/.test(c.text)).params, [7, "all"]);
  } finally {
    stub.restore();
  }
});

test("a forged or broken link is refused", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const forged = jwt.sign({ sub: "7", cat: "sessions", purpose: "unsubscribe" }, "not-the-key");
    const res = await request(app).post("/api/notifications/unsubscribe").send({ token: forged });
    assert.equal(res.status, 400);
    assert.equal(stub.calls.length, 0);
  } finally {
    stub.restore();
  }
});

test("the preferences offer a student only the mail a student can get", async () => {
  const { row, cookie } = session("student");
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM notification_email_optouts/.test(text)) return { rows: [{ category: "sessions" }] };
    if (/FROM users/.test(text)) return { rows: [row] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/notifications/preferences").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.categories, [
      { key: "sessions", email: false },
      { key: "new_lessons", email: true },
    ]);
    assert.equal(res.body.allOff, false);
  } finally {
    stub.restore();
  }
});

test("a preference is switched for the caller, and an unknown category is refused", async () => {
  const { row, cookie } = session("lecturer");
  const stub = stubPoolQuery(pool, (text) => (/FROM users/.test(text) ? { rows: [row] } : { rows: [] }));
  try {
    const on = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "processing", email: true });
    assert.equal(on.status, 204);
    const del = stub.calls.find((c) => /DELETE FROM notification_email_optouts/.test(c.text));
    assert.deepEqual(del.params, [7, "processing"]);

    const bad = await request(app).put("/api/notifications/preferences").set("Cookie", cookie).send({ category: "everything", email: false });
    assert.equal(bad.status, 400);
  } finally {
    stub.restore();
  }
});

test("a notification mail carries its unsubscribe link and header", async () => {
  const { withUnsubscribe } = await import("../lib/mailer.js");
  const message = withUnsubscribe(notificationEmail("new_lesson", { title: "ש", mediaId: 1 }), "a.b.c");
  assert.match(message.text, /\/unsubscribe\?token=a\.b\.c/);
  assert.match(message.html, /href="[^"]*\/unsubscribe\?token=a\.b\.c"/);
  assert.match(message.headers["List-Unsubscribe"], /^<.*\/unsubscribe\?token=a\.b\.c>$/);
  // It links to the client's confirmation page, never to the API's POST.
  assert.doesNotMatch(message.text, /\/api\//);
});

test("no token is ever signed with an empty secret", () => {
  const saved = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  try {
    assert.throws(() => signUnsubscribeToken(7, "sessions"), /JWT_SECRET/);
    assert.equal(readUnsubscribeToken("a.b.c"), null);
  } finally {
    process.env.JWT_SECRET = saved;
  }
});
