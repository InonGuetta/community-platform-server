import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolConnect } from "./setup.js";
import { updateUser, deleteUser } from "../services/servicesUsers.js";

// Losing the last admin is unrecoverable through the UI, so the guard matters
// more than the convenience it costs. It also has to serialise correctly: two
// admins demoted at once would otherwise each see the other as still active.

const fakeDb = ({ target, activeAdmins = [], emailTakenBy = null }) =>
  stubPoolConnect(pool, (text) => {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) return { rows: [] };
    if (/SELECT role, is_active FROM users WHERE id=/i.test(text)) {
      return { rows: target ? [target] : [] };
    }
    if (/SELECT id FROM users WHERE email=/i.test(text)) {
      return { rows: emailTakenBy ? [{ id: emailTakenBy }] : [] };
    }
    if (/role='admin' AND is_active=TRUE/i.test(text)) {
      return { rows: activeAdmins.map((id) => ({ id })) };
    }
    if (/^\s*UPDATE users SET/i.test(text)) {
      return { rows: [{ id: 5, email: "a@b.c", role: "student", is_active: true }] };
    }
    return { rows: [] };
  });

const ADMIN = { role: "admin", is_active: true };
const STUDENT = { role: "student", is_active: true };

test("demoting the last active admin is refused", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5] });
  try {
    await assert.rejects(() => updateUser(5, { role: "student" }), /last active admin/);
  } finally {
    db.restore();
  }
});

test("deactivating the last active admin is refused", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5] });
  try {
    await assert.rejects(() => updateUser(5, { isActive: false }), /last active admin/);
  } finally {
    db.restore();
  }
});

test("soft-delete goes through the same guard", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5] });
  try {
    await assert.rejects(() => deleteUser(5), /last active admin/);
  } finally {
    db.restore();
  }
});

// The escape hatch that keeps the guard from being a trap: promote a
// replacement first and the demotion becomes legal.
test("demoting an admin is allowed once another active admin exists", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5, 9] });
  try {
    await assert.doesNotReject(() => updateUser(5, { role: "student" }));
  } finally {
    db.restore();
  }
});

// req.params.id arrives as a string; comparing it to a numeric row id without
// coercion silently let the last admin through.
test("a string id still matches the numeric row id", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5] });
  try {
    await assert.rejects(() => updateUser("5", { role: "student" }), /last active admin/);
  } finally {
    db.restore();
  }
});

test("non-admins are unaffected by the guard", async () => {
  const db = fakeDb({ target: STUDENT, activeAdmins: [9] });
  try {
    await assert.doesNotReject(() => updateUser(5, { role: "lecturer" }));
  } finally {
    db.restore();
  }
});

test("the active-admin set is locked in a deterministic order", async () => {
  const db = fakeDb({ target: ADMIN, activeAdmins: [5, 9] });
  try {
    await updateUser(5, { role: "student" });
    const lock = db.calls.find((c) => /role='admin'/i.test(c.text));
    assert.match(lock.text, /FOR UPDATE/, "concurrent demotions must serialise");
    assert.match(lock.text, /ORDER BY id/, "a fixed lock order is what avoids a deadlock");
  } finally {
    db.restore();
  }
});

test("the email is normalised, as it is on create", async () => {
  const db = fakeDb({ target: STUDENT, activeAdmins: [9] });
  try {
    await updateUser(5, { email: "  Admin@Example.COM " });
    const update = db.calls.find((c) => /^\s*UPDATE users SET/i.test(c.text));
    assert.equal(update.params[0], "admin@example.com", "login lowercases, so this must too");
  } finally {
    db.restore();
  }
});

test("a duplicate email is a conflict, not a 500", async () => {
  const db = fakeDb({ target: STUDENT, activeAdmins: [9], emailTakenBy: 8 });
  try {
    const err = await updateUser(5, { email: "taken@example.com" }).catch((e) => e);
    assert.equal(err.statusCode, 409);
  } finally {
    db.restore();
  }
});

test("an invalid role is rejected before touching the database", async () => {
  await assert.rejects(() => updateUser(5, { role: "superuser" }), { statusCode: 400 });
});

test("a missing user is a 404", async () => {
  const db = fakeDb({ target: null });
  try {
    await assert.rejects(() => updateUser(5, { role: "student" }), { statusCode: 404 });
  } finally {
    db.restore();
  }
});
