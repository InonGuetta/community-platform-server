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

// Choosing a role at signup, and an admin deciding on it.
//
// The first test in this file is the reason the whole feature is shaped the way
// it is. Registration is PUBLIC and UNAUTHENTICATED. The moment it accepts a
// role field, "become an admin" is one HTTP request away unless the value lands
// somewhere that grants nothing. Everything else here is behaviour; that one is
// the security boundary.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

// ── Registration ────────────────────────────────────────────────────────────

// Captures the INSERT so the assertions read what was actually sent to Postgres
// rather than what the response chose to echo back.
const captureRegistration = () => {
  const calls = [];
  stubPoolQuery(pool, async (text, params) => {
    calls.push({ text, params });
    if (/SELECT id FROM users WHERE email/i.test(text)) return { rows: [] };
    if (/INSERT INTO users/i.test(text)) {
      return { rows: [{ id: 1, email: "x@example.com", role: "student", display_name: null }] };
    }
    return { rows: [] };
  });
  return calls;
};

const registerAs = (requestedRole) =>
  request(app)
    .post("/api/auth/register")
    .send({ email: "x@example.com", password: "correct horse battery", requestedRole });

// ⚠️ THE TEST THIS FEATURE EXISTS TO KEEP PASSING ⚠️
test("asking to be an admin does NOT create an admin", async () => {
  const calls = captureRegistration();
  const res = await registerAs("admin");

  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO users/i.test(c.text));
  assert.ok(insert, "the registration reached an INSERT");

  // Only the COLUMN LIST is inspected. The RETURNING clause reads `role` back
  // and is supposed to — reading the value is not writing it. The schema default
  // is what makes the account a student, and naming the column in the insert is
  // how that gets undone.
  const columnList = insert.text.match(/INSERT INTO users\s*\(([^)]*)\)/i)[1];
  assert.doesNotMatch(
    columnList.replace(/requested_role/g, ""),
    /\brole\b/,
    `the INSERT must not write users.role — that is privilege escalation. Columns were: ${columnList}`
  );
  assert.ok(insert.params.includes("admin"), "the request itself is recorded");
  assert.ok(insert.params.includes("pending"), "and it is recorded as pending");
});

test("the same is true of a lecturer request", async () => {
  const calls = captureRegistration();
  await registerAs("lecturer");
  const insert = calls.find((c) => /INSERT INTO users/i.test(c.text));
  assert.ok(insert.params.includes("pending"));
});

// A student is the ordinary case and must not have grown a waiting step.
test("a student registers with no approval step", async () => {
  const calls = captureRegistration();
  const res = await registerAs("student");
  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO users/i.test(c.text));
  assert.ok(insert.params.includes("approved"), "a student is approved on the spot");
});

// The old client sends no role at all and must keep working unchanged.
test("registration with no role at all still works and means student", async () => {
  const calls = captureRegistration();
  const res = await request(app)
    .post("/api/auth/register")
    .send({ email: "x@example.com", password: "correct horse battery" });
  assert.equal(res.status, 201);
  const insert = calls.find((c) => /INSERT INTO users/i.test(c.text));
  assert.ok(insert.params.includes("approved"));
});

test("a role that is not one of the three is refused", async () => {
  captureRegistration();
  const res = await registerAs("superuser");
  assert.equal(res.status, 400);
});

// ── Approving ───────────────────────────────────────────────────────────────

const ADMIN = { id: 5, email: "admin@example.com", role: "admin", is_active: true };
const adminToken = jwt.sign({ id: 5, email: ADMIN.email, role: "admin" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const APPLICANT = {
  id: 9,
  email: "wants@example.com",
  display_name: "מבקש",
  requested_role: "lecturer",
  approval_status: "pending",
};

// verifyToken reads the admin's row through pool.query; the approval itself runs
// on a pooled client, so both have to be stubbed.
const stubApproval = (applicant = APPLICANT) => {
  stubPoolQuery(pool, async (text) => {
    if (/FROM users/i.test(text)) return { rows: [ADMIN] };
    return { rows: [] };
  });
  // stubPoolConnect's impl answers a QUERY; the harness builds the client and
  // records the calls itself, which is what `.calls` below is.
  const handle = stubPoolConnect(pool, (text) => {
    if (/FOR UPDATE/i.test(text)) return { rows: [applicant] };
    if (/UPDATE users/i.test(text)) {
      return { rows: [{ ...applicant, role: applicant.requested_role, approval_status: "approved" }] };
    }
    return { rows: [] };
  });
  return handle.calls;
};

test("approving grants the role that was requested, and stamps who did it", async () => {
  const calls = stubApproval();
  const res = await request(app)
    .post("/api/users/9/approve")
    .set("Cookie", `token=${adminToken}`);

  assert.equal(res.status, 200);
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.ok(update, "the approval reached an UPDATE");
  assert.match(update.text, /approved_by/, "the deciding admin is recorded");
  assert.match(update.text, /approved_at/);
  assert.ok(update.params.includes("lecturer"), "the requested role is what is granted");
  // The admin's own id, not the applicant's.
  assert.ok(update.params.includes(5));
});

// The role and the status must move together, or an account briefly holds the
// role while still listed as waiting — and the tab offers to approve it again.
test("the role and the status change in one statement", async () => {
  const calls = stubApproval();
  await request(app).post("/api/users/9/approve").set("Cookie", `token=${adminToken}`);
  const updates = calls.filter((c) => /UPDATE users/i.test(c.text));
  assert.equal(updates.length, 1, "one UPDATE, not two");
  assert.match(updates[0].text, /role\s*=/);
  assert.match(updates[0].text, /approval_status\s*=/);
});

test("it runs in a transaction", async () => {
  const calls = stubApproval();
  await request(app).post("/api/users/9/approve").set("Cookie", `token=${adminToken}`);
  assert.ok(calls.some((c) => /BEGIN/i.test(c.text)));
  assert.ok(calls.some((c) => /COMMIT/i.test(c.text)));
});

// The lock is what stops two admins both writing approved_by for one decision.
test("the pending row is locked before it is read", async () => {
  const calls = stubApproval();
  await request(app).post("/api/users/9/approve").set("Cookie", `token=${adminToken}`);
  assert.ok(calls.some((c) => /FOR UPDATE/i.test(c.text)), "SELECT ... FOR UPDATE");
});

test("a request that was already decided is refused rather than re-applied", async () => {
  stubApproval({ ...APPLICANT, approval_status: "approved" });
  const res = await request(app).post("/api/users/9/approve").set("Cookie", `token=${adminToken}`);
  assert.equal(res.status, 409);
});

// Sign up as an admin, then approve yourself — the whole feature defeated in two
// requests. Enforced in the service, not by hiding the button.
test("an admin cannot approve their own request", async () => {
  stubApproval({ ...APPLICANT, id: 5 });
  const res = await request(app).post("/api/users/5/approve").set("Cookie", `token=${adminToken}`);
  assert.equal(res.status, 400);
});

// ── Rejecting ───────────────────────────────────────────────────────────────

test("rejecting leaves the account working and does not touch its role", async () => {
  const calls = stubApproval();
  const res = await request(app)
    .post("/api/users/9/reject")
    .set("Cookie", `token=${adminToken}`)
    .send({ reason: "לא מוכר לנו" });

  assert.equal(res.status, 200);
  const update = calls.find((c) => /UPDATE users/i.test(c.text));
  assert.doesNotMatch(update.text, /\brole\s*=/, "a refusal must not change the role");
  assert.doesNotMatch(update.text, /is_active/, "nor deactivate the account");
  assert.ok(update.params.includes("לא מוכר לנו"), "the reason is kept for the email");
});

// ── The routes themselves ───────────────────────────────────────────────────

test("the approval routes are admin-only", async () => {
  const lecturerToken = jwt.sign(
    { id: 6, email: "l@example.com", role: "lecturer" },
    process.env.JWT_SECRET,
    { expiresIn: "1h" }
  );
  stubPoolQuery(pool, async () => ({
    rows: [{ id: 6, email: "l@example.com", role: "lecturer", is_active: true }],
  }));

  for (const path of ["/api/users/pending", "/api/users/9/approve"]) {
    const res = await (path.endsWith("pending")
      ? request(app).get(path)
      : request(app).post(path)
    ).set("Cookie", `token=${lecturerToken}`);
    assert.equal(res.status, 403, `${path} answered ${res.status}`);
  }
});

// "/pending" is declared before "/:id" on purpose; the other order makes
// validateIntParam reject the literal word and the route unreachable.
test("/pending is not swallowed by the /:id route", async () => {
  stubPoolQuery(pool, async (text) => {
    if (/approval_status = 'pending'/i.test(text)) return { rows: [APPLICANT] };
    if (/FROM users/i.test(text)) return { rows: [ADMIN] };
    return { rows: [] };
  });
  const res = await request(app).get("/api/users/pending").set("Cookie", `token=${adminToken}`);
  assert.equal(res.status, 200, "a 400 here means the route order regressed");
  assert.ok(Array.isArray(res.body));
});
