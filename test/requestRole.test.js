import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Asking for a role after registration.
//
// This closes a hole the signup role picker left open rather than adding a
// convenience: a Google sign-in never sees the signup form — the OAuth callback
// returns straight into the app — so without this endpoint a Google account
// could never request anything, permanently. The other case it serves is a
// long-standing student who starts giving a shiur.
//
// The invariant is the same one register carries, and for the same reason: this
// endpoint writes requested_role, never users.role.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const tokenFor = (u) =>
  jwt.sign({ id: u.id, email: u.email, role: u.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

const STUDENT = {
  id: 3,
  email: "s@example.com",
  role: "student",
  is_active: true,
  approval_status: "approved",
  requested_role: "student",
  approved_at: null,
};

// The caller's row is read twice — once by verifyToken, once by the service —
// and both go through pool.query, so one stub answers both.
const capture = (user = STUDENT) => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/UPDATE users/i.test(text)) {
      return { rows: [{ ...user, requested_role: params[0], approval_status: "pending" }] };
    }
    if (/FROM users/i.test(text)) return { rows: [user] };
    return { rows: [] };
  });
  return calls;
};

const ask = (user, requestedRole) =>
  request(app)
    .post("/api/auth/request-role")
    .set("Cookie", `token=${tokenFor(user)}`)
    .send({ requestedRole });

// ── The ordinary case ───────────────────────────────────────────────────────

test("a student may ask to become a lecturer", async () => {
  const calls = capture();
  const res = await ask(STUDENT, "lecturer");

  assert.equal(res.status, 200);
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.ok(update, "the request reached an UPDATE");
  assert.ok(update.params.includes("lecturer"));
});

// The same invariant register carries. This endpoint is authenticated, so the
// blast radius is smaller — but "authenticated" is every signed-in user, and a
// student writing their own role is still the whole permission model gone.
test("the request does NOT write users.role", async () => {
  const calls = capture();
  await ask(STUDENT, "admin");
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  const setClause = update.text.split(/WHERE/i)[0];
  assert.doesNotMatch(
    setClause.replace(/requested_role/g, ""),
    /\brole\s*=/,
    `only approveUser may grant a role. SET clause was: ${setClause}`
  );
});

// It has to produce a row the SAME admin queue picks up, or there are two
// approval flows and one of them has no screen.
test("it lands in the same pending queue the signup path uses", async () => {
  const calls = capture();
  await ask(STUDENT, "lecturer");
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.ok(update.text.includes("approval_status = 'pending'"));
});

// A refusal belongs to the decision that was made, not to the one now waiting.
test("a previous refusal's reason is cleared, not shown beside the new request", async () => {
  const calls = capture({
    ...STUDENT,
    approval_status: "rejected",
    // Long enough ago to be past the cooldown.
    approved_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
  });
  await ask(STUDENT, "lecturer");
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.match(update.text, /rejection_reason = NULL/);
  assert.match(update.text, /approved_by = NULL/, "and the old decider is cleared too");
});

// ── What must be refused ────────────────────────────────────────────────────

test("asking for 'student' is refused — everybody already is one", async () => {
  capture();
  const res = await ask(STUDENT, "student");
  assert.equal(res.status, 400);
});

test("a role that does not exist is refused", async () => {
  capture();
  const res = await ask(STUDENT, "superuser");
  assert.equal(res.status, 400);
});

test("asking for a role you already hold is refused", async () => {
  const lecturer = { ...STUDENT, id: 4, role: "lecturer" };
  capture(lecturer);
  const res = await ask(lecturer, "lecturer");
  assert.equal(res.status, 409);
});

// Otherwise a self-service form quietly removes somebody's own admin rights the
// moment an approval lands. Role reduction is an admin action on the users tab.
test("an admin cannot demote themselves through this endpoint", async () => {
  const admin = { ...STUDENT, id: 5, role: "admin" };
  capture(admin);
  const res = await ask(admin, "lecturer");
  assert.equal(res.status, 400);
});

test("a second request while one is already waiting is refused", async () => {
  capture({ ...STUDENT, approval_status: "pending", requested_role: "lecturer" });
  const res = await ask(STUDENT, "admin");
  assert.equal(res.status, 409);
});

// Not against abuse — an approval is a human decision. Against the loop where a
// refusal produces an immediate identical re-application.
test("re-applying within the cooldown is refused, and says how long is left", async () => {
  capture({
    ...STUDENT,
    approval_status: "rejected",
    approved_at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
  });
  const res = await ask(STUDENT, "lecturer");
  assert.equal(res.status, 400);
  assert.match(res.body.message, /day/i, "the refusal tells them when they may try again");
});

test("re-applying after the cooldown is allowed", async () => {
  capture({
    ...STUDENT,
    approval_status: "rejected",
    approved_at: new Date(Date.now() - 10 * 86_400_000).toISOString(),
  });
  const res = await ask(STUDENT, "lecturer");
  assert.equal(res.status, 200);
});

// ── Reach ───────────────────────────────────────────────────────────────────

test("it requires a session", async () => {
  const res = await request(app).post("/api/auth/request-role").send({ requestedRole: "lecturer" });
  assert.equal(res.status, 401);
});

// The endpoint takes no id, so there is nothing to point at somebody else. This
// asserts the property rather than trying to exploit it.
test("it acts on the caller and takes no id from the body", async () => {
  const calls = capture();
  // The ids in the body are the point: they must be ignored entirely.
  await request(app)
    .post("/api/auth/request-role")
    .set("Cookie", `token=${tokenFor(STUDENT)}`)
    .send({ requestedRole: "lecturer", userId: 999, id: 999 });
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.ok(update.params.includes(STUDENT.id), "the caller's own id");
  assert.ok(!update.params.includes(999), "and nothing from the body");
});

// The profile shows "declined" and has to be able to say why.
test("getMe carries the refusal reason so the profile can show it", async () => {
  let meSql = "";
  stubPoolQuery(pool, (text) => {
    if (/FROM users WHERE id=\$1 AND is_active=TRUE/i.test(text)) {
      meSql = text;
      return { rows: [STUDENT] };
    }
    if (/FROM users/i.test(text)) return { rows: [STUDENT] };
    return { rows: [] };
  });

  const res = await request(app).get("/api/auth/me").set("Cookie", `token=${tokenFor(STUDENT)}`);
  assert.equal(res.status, 200);
  assert.match(meSql, /rejection_reason/);
  assert.match(meSql, /approval_status/);
});
