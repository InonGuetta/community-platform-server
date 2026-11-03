import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";
import {
  newJoinCode,
  normaliseJoinCode,
  setJoinCode,
  JOIN_CODE_ALPHABET,
  JOIN_CODE_LENGTH,
} from "../services/servicesCourseJoin.js";

// Joining a course by its code (PRD ROST-9, migration 042): the code is the
// lecturer's to hand out and nobody else's to see, typing it files a request
// rather than enrolling, and the lecturer's approval is what enrols.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const OWNER = { id: 10, email: "owner@example.com", role: "lecturer", is_active: true };
const OTHER = { id: 11, email: "other@example.com", role: "lecturer", is_active: true };
const STUDENT = { id: 13, email: "student@example.com", role: "student", display_name: "דנה", is_active: true };

const cookieFor = (user) =>
  `token=${jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const COURSE = {
  id: 4, title: "גמרא", lecturer_id: OWNER.id, lecturer_name: "הרב כהן", is_active: true,
  join_code: "ABC234", pending_join_count: 2, student_count: 7, media_count: 3,
};

// The caller's row for verifyToken, and whatever the handler asks after it.
// Course queries are matched first: they JOIN users too.
const db = (caller, handlers = {}) =>
  stubPoolQuery(pool, (text, params) => {
    for (const [pattern, answer] of Object.entries(handlers)) {
      if (new RegExp(pattern, "i").test(text)) return typeof answer === "function" ? answer(text, params) : answer;
    }
    if (/FROM courses/i.test(text)) return { rows: [COURSE] };
    if (/FROM users/i.test(text)) return { rows: [caller] };
    return { rows: [] };
  });

const notificationRecipients = (calls) =>
  calls.filter((c) => /INSERT INTO notifications/i.test(c.text)).map((c) => JSON.stringify(c.params));

// ── The code itself ─────────────────────────────────────────────────────────

test("a code is six characters with no look-alikes", () => {
  for (let i = 0; i < 200; i += 1) {
    const code = newJoinCode();
    assert.equal(code.length, JOIN_CODE_LENGTH);
    for (const char of code) assert.ok(JOIN_CODE_ALPHABET.includes(char), code);
  }
  assert.doesNotMatch(JOIN_CODE_ALPHABET, /[01OIL]/);
});

test("what a person types is read the way they meant it", () => {
  assert.equal(normaliseJoinCode(" abc-234 "), "ABC234");
  assert.equal(normaliseJoinCode("abc 234"), "ABC234");
  assert.equal(normaliseJoinCode(""), null);
  assert.equal(normaliseJoinCode("a;drop"), null);
  assert.equal(normaliseJoinCode(null), null);
});

test("a code that collides with another course's is drawn again", async () => {
  let attempts = 0;
  const stub = stubPoolQuery(pool, () => {
    attempts += 1;
    if (attempts === 1) throw Object.assign(new Error("duplicate"), { code: "23505" });
    return { rows: [{ join_code: "XYZ789" }] };
  });
  try {
    assert.equal(await setJoinCode(4), "XYZ789");
    assert.equal(attempts, 2);
  } finally {
    stub.restore();
  }
});

// ── Who sees it ─────────────────────────────────────────────────────────────

test("the catalogue shows the code and the queue to the course's lecturer only", async () => {
  for (const [caller, sees] of [[OWNER, true], [OTHER, false], [STUDENT, false]]) {
    const stub = db(caller);
    try {
      const res = await request(app).get("/api/courses").set("Cookie", cookieFor(caller));
      assert.equal(res.status, 200);
      assert.equal("join_code" in res.body[0], sees, `${caller.email} join_code`);
      assert.equal("pending_join_count" in res.body[0], sees, `${caller.email} pending_join_count`);
    } finally {
      stub.restore();
    }
  }
});

test("a student's own courses never carry the code", async () => {
  const stub = db(STUDENT, { "FROM enrollments e": { rows: [COURSE] } });
  try {
    const res = await request(app).get("/api/courses/my").set("Cookie", cookieFor(STUDENT));
    assert.equal(res.status, 200);
    assert.equal("join_code" in res.body[0], false);
  } finally {
    stub.restore();
  }
});

test("only the course's lecturer may make, replace or read its queue", async () => {
  const stub = db(OTHER);
  try {
    for (const [method, path] of [
      ["post", "/api/courses/4/join-code"],
      ["delete", "/api/courses/4/join-code"],
      ["get", "/api/courses/4/join-requests"],
    ]) {
      const res = await request(app)[method](path).set("Cookie", cookieFor(OTHER));
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  } finally {
    stub.restore();
  }
});

// ── Asking to join ──────────────────────────────────────────────────────────

// The stub stays in place until the notification — sent without awaiting —
// has had its turn, so it is recorded here and never reaches a real pool.
const join = async (caller, code, handlers) => {
  const stub = db(caller, handlers);
  try {
    const res = await request(app).post("/api/courses/join").set("Cookie", cookieFor(caller)).send({ code });
    await new Promise((resolve) => setImmediate(resolve));
    return { res, calls: stub.calls };
  } finally {
    stub.restore();
  }
};

test("a code files a request, names the course, and tells its lecturer", async () => {
  const { res, calls } = await join(STUDENT, "abc-234", {
    "FROM enrollments": { rows: [] },
    "INSERT INTO course_join_requests": { rows: [{ id: 31 }] },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(res.body, { status: "pending", course: { id: 4, title: "גמרא", lecturer_name: "הרב כהן" } });
  // Looked up as the person meant it.
  assert.deepEqual(calls.find((c) => /WHERE c\.join_code/.test(c.text)).params, ["ABC234"]);
  // Nobody was enrolled by the code itself.
  assert.equal(calls.some((c) => /INSERT INTO enrollments/i.test(c.text)), false);
  // The course's lecturer is told, and by name of who asked.
  const [sent] = notificationRecipients(calls);
  assert.ok(sent?.includes(String(OWNER.id)) && sent.includes("course_join_request"), sent);
});

test("asking again while the request waits does not tell the lecturer twice", async () => {
  const { res, calls } = await join(STUDENT, "ABC234", {
    "FROM enrollments": { rows: [] },
    "INSERT INTO course_join_requests": { rows: [] },
  });
  assert.equal(res.status, 202);
  assert.deepEqual(notificationRecipients(calls), []);
});

test("a wrong code, a closed course, an existing student and the course's own lecturer each hear why", async () => {
  const wrong = await join(STUDENT, "ZZZZZZ", { "FROM courses c LEFT JOIN users": { rows: [] } });
  assert.equal(wrong.res.status, 404);
  assert.equal(wrong.res.body.code, "JOIN_CODE_NOT_FOUND");

  const enrolled = await join(STUDENT, "ABC234", { "FROM enrollments": { rows: [{ "?column?": 1 }] } });
  assert.equal(enrolled.res.status, 409);
  assert.equal(enrolled.res.body.code, "ALREADY_ENROLLED");

  const own = await join(OWNER, "ABC234");
  assert.equal(own.res.status, 400);
  assert.equal(own.res.body.code, "COURSE_IS_YOURS");

  const garbage = await join(STUDENT, "!!");
  assert.equal(garbage.res.status, 404);
  assert.equal(garbage.calls.some((c) => /join_code/.test(c.text)), false);
});

test("a closed course is looked for only among active ones", async () => {
  const { calls } = await join(STUDENT, "ABC234", { "FROM courses c LEFT JOIN users": { rows: [] } });
  assert.match(calls.find((c) => /WHERE c\.join_code/.test(c.text)).text, /is_active = TRUE/);
});

// ── Deciding ────────────────────────────────────────────────────────────────

const decide = async (caller, verb, txAnswer) => {
  const query = db(caller);
  const tx = stubPoolConnect(pool, txAnswer);
  try {
    const res = await request(app).post(`/api/courses/4/join-requests/31/${verb}`).set("Cookie", cookieFor(caller));
    await new Promise((resolve) => setImmediate(resolve));
    return { res, tx: tx.calls, query: query.calls };
  } finally {
    tx.restore();
    query.restore();
  }
};

test("approving enrols in the same transaction, and tells the student", async () => {
  const { res, tx, query } = await decide(OWNER, "approve", (text) =>
    /UPDATE course_join_requests/.test(text) ? { rows: [{ user_id: STUDENT.id }] } : { rows: [] }
  );
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { id: 31, status: "approved" });
  const [sent] = notificationRecipients(query);
  assert.ok(sent?.includes(String(STUDENT.id)) && sent.includes("course_join_approved"), sent);
  const order = tx.map((c) => c.text.trim().split(/\s+/).slice(0, 3).join(" "));
  const update = tx.findIndex((c) => /UPDATE course_join_requests/.test(c.text));
  const enrol = tx.findIndex((c) => /INSERT INTO enrollments/.test(c.text));
  assert.ok(order[0] === "BEGIN" && update > 0 && enrol > update && order.at(-1) === "COMMIT", order.join(" | "));
  // Scoped to THIS course: a request id from another course's queue matches nothing.
  assert.deepEqual(tx[update].params.slice(0, 2).map(Number), [31, 4]);
  assert.deepEqual(tx[enrol].params.map(Number), [STUDENT.id, 4]);
});

test("refusing enrols nobody", async () => {
  const { res, tx } = await decide(OWNER, "reject", (text) =>
    /UPDATE course_join_requests/.test(text) ? { rows: [{ user_id: STUDENT.id }] } : { rows: [] }
  );
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "rejected");
  assert.equal(tx.some((c) => /INSERT INTO enrollments/.test(c.text)), false);
});

test("a request already decided is a 409, and one on another course a 404", async () => {
  const decided = await decide(OWNER, "approve", (text) =>
    /SELECT 1 FROM course_join_requests/.test(text) ? { rows: [{ "?column?": 1 }] } : { rows: [] }
  );
  assert.equal(decided.res.status, 409);
  assert.equal(decided.res.body.code, "JOIN_REQUEST_DECIDED");
  assert.ok(decided.tx.some((c) => c.text === "ROLLBACK"));

  const elsewhere = await decide(OWNER, "approve", () => ({ rows: [] }));
  assert.equal(elsewhere.res.status, 404);
});

test("another lecturer cannot decide this course's requests", async () => {
  const { res, tx } = await decide(OTHER, "approve", () => ({ rows: [{ user_id: 13 }] }));
  assert.equal(res.status, 403);
  assert.equal(tx.length, 0);
});

// ── The student's own requests ──────────────────────────────────────────────

test("withdrawing a request is only ever one's own", async () => {
  const stub = db(STUDENT, { "DELETE FROM course_join_requests": { rows: [], rowCount: 0 } });
  try {
    const res = await request(app).delete("/api/courses/join-requests/31").set("Cookie", cookieFor(STUDENT));
    assert.equal(res.status, 404);
    const del = stub.calls.find((c) => /DELETE FROM course_join_requests/.test(c.text));
    assert.match(del.text, /user_id = \$2/);
    assert.deepEqual(del.params.map(Number), [31, STUDENT.id]);
  } finally {
    stub.restore();
  }
});
