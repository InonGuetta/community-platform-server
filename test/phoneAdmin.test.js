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

// What an admin sees of members' phones and of SMS (PRD AUTH-13): a verified
// number masked, never whole, never a waiting one; and the month's SMS cost.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});
const app = createApp();
const as = (role, id = 1) => {
  const row = { id, email: "a@example.com", role };
  return { row, cookie: `token=${jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" })}` };
};
const AUTH = /FROM users WHERE id=\$1 AND is_active=TRUE/;

test("the users list shows a verified number masked, and no number that is only waiting", async () => {
  const { row, cookie } = as("admin");
  const s = stubPoolQuery(pool, (text) => {
    if (AUTH.test(text)) return { rows: [row] };
    if (/FROM users ORDER BY created_at DESC/.test(text)) {
      return { rows: [
        { id: 2, email: "v@example.com", phone_e164: "+972545551234", phone_verified_at: new Date() },
        { id: 3, email: "w@example.com", phone_e164: "+972545559999", phone_verified_at: null },
        { id: 4, email: "n@example.com", phone_e164: null, phone_verified_at: null },
      ] };
    }
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/users/get-all-users").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.map((u) => u.phone_masked), ["+972•••••1234", null, null]);
    const body = JSON.stringify(res.body);
    assert.ok(!body.includes("545551234") && !body.includes("545559999"), "no whole number leaves the server");
    assert.ok(res.body.every((u) => !("phone_e164" in u) && !("phone_verified_at" in u)));
  } finally {
    s.restore();
  }
});

test("the month's SMS cost, for an admin only", async () => {
  const admin = as("admin");
  const s = stubPoolQuery(pool, (text) => {
    if (AUTH.test(text)) return { rows: [admin.row] };
    if (/GROUP BY purpose/.test(text)) return { rows: [{ purpose: "verification", messages: 3, failed: 0, segments: 3, cost_usd: 0.6 }] };
    if (/SUM\(cost_usd\)/.test(text)) return { rows: [{ spent: 0.6 }] };
    return { rows: [] };
  });
  try {
    const res = await request(app).get("/api/admin/sms-usage").set("Cookie", admin.cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.spentUsd, 0.6);
    assert.equal(res.body.capUsd, null);
    assert.equal(res.body.configured, false);
    assert.equal(res.body.byPurpose[0].purpose, "verification");
  } finally {
    s.restore();
  }
  const lecturer = as("lecturer", 5);
  const s2 = stubPoolQuery(pool, (text) => (AUTH.test(text) ? { rows: [lecturer.row] } : { rows: [] }));
  try {
    const res = await request(app).get("/api/admin/sms-usage").set("Cookie", lecturer.cookie);
    assert.equal(res.status, 403);
  } finally {
    s2.restore();
  }
});

test("signing in returns the phone as getMe gives it, so the account page needs no reload", async () => {
  const bcrypt = (await import("bcryptjs")).default;
  const row = {
    id: 8, email: "p@example.com", role: "student", is_active: true, password_hash: bcrypt.hashSync("correct-horse", 4),
    phone_e164: "+972545551234", phone_verified_at: new Date(),
  };
  const s = stubPoolQuery(pool, (text) => (/FROM users WHERE email=\$1/.test(text) ? { rows: [row] } : { rows: [] }));
  try {
    const res = await request(app).post("/api/auth/login").send({ email: row.email, password: "correct-horse" });
    assert.equal(res.status, 200);
    assert.equal(res.body.user.phone, "+972545551234");
    assert.equal(res.body.user.phone_pending, null);
    assert.ok(!("phone_e164" in res.body.user) && !("password_hash" in res.body.user));
  } finally {
    s.restore();
  }
});
