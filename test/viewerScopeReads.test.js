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

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

// The archive listing, its count and the tag tree's counts, through the real
// routes: each must bind the viewer's scope — which published lessons, whose
// drafts — as the first two parameters of its statement, exactly as
// viewerScopeFor resolves it for that role. The listing and the tree are the two
// reads that used to receive the scope under other names.

const app = createApp();

const ADMIN = { id: 1, email: "a@example.com", role: "admin", is_active: true };
const LECTURER = { id: 10, email: "l@example.com", role: "lecturer", is_active: true };
const STUDENT = { id: 7, email: "s@example.com", role: "student", is_active: true };

const tokenFor = (user) =>
  jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: "1h" });

// Runs a GET as `user` and returns the statements the handler sent, other than
// the user lookup and the enrolment lookup.
const statementsFor = async (user, url) => {
  const db = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [user] };
    if (/FROM enrollments/i.test(text)) return { rows: [{ course_id: 5 }, { course_id: 8 }] };
    if (/COUNT\(\*\)::int AS count/.test(text)) return { rows: [{ count: 0 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get(url).set("Cookie", `token=${tokenFor(user)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return db.calls.filter(({ text }) => !/FROM users|FROM enrollments/i.test(text));
  } finally {
    db.restore();
  }
};

const SCOPES = [
  ["an admin", ADMIN, [null, null]],
  ["a lecturer", LECTURER, [null, [10]]],
  ["a student", STUDENT, [[5, 8], []]],
];

for (const [who, user, scope] of SCOPES) {
  test(`the archive page and its count are filtered by ${who}'s scope`, async () => {
    const calls = await statementsFor(user, "/api/media/get-all");
    const page = calls.find(({ text }) => /ORDER BY/.test(text));
    const count = calls.find(({ text }) => /COUNT\(\*\)::int AS count/.test(text));
    assert.ok(page && count, "both the page and the count were asked for");
    assert.deepEqual(page.params.slice(0, 2), scope);
    assert.deepEqual(count.params, scope, "the count binds the same scope and nothing else");
  });

  test(`the tag tree counts what ${who} may see`, async () => {
    const calls = await statementsFor(user, "/api/media/tags");
    const tree = calls.find(({ text }) => /WITH RECURSIVE descendants/.test(text));
    assert.ok(tree, "the tree was asked for");
    assert.deepEqual(tree.params, scope);
  });
}

test("the caller's own filters come after the scope", async () => {
  const calls = await statementsFor(LECTURER, "/api/media/get-all?published=false&type=video");
  const count = calls.find(({ text }) => /COUNT\(\*\)::int AS count/.test(text));
  assert.deepEqual(count.params, [null, [10], ["video"], false]);
});
