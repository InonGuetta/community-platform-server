import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "crypto";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import {
  requestPasswordReset,
  resetPassword,
  changePassword,
  updateProfile,
  tokenPredatesPasswordChange,
} from "../services/servicesAuth.js";

// Getting back into an account you are locked out of, which until now was not
// possible at all — and the two properties that decide whether it is a recovery
// feature or a second way in for whoever else can read the inbox.

const ACTIVE = { id: 4, password_hash: "$2a$12$hash" };

// ── Asking for a link ───────────────────────────────────────────────────────

test("a token is issued for an account that can use one", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM users/i.test(text) ? { rows: [ACTIVE] } : { rows: [] }
  );
  try {
    const token = await requestPasswordReset("a@example.com");
    assert.match(token, /^[0-9a-f]{64}$/, "32 random bytes, hex");
  } finally {
    stub.restore();
  }
});

// The token is a live credential. A table full of them is a list of one-click
// takeovers, so what is stored is a digest and the token itself never lands.
test("only a hash of the token reaches the database", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM users/i.test(text) ? { rows: [ACTIVE] } : { rows: [] }
  );
  try {
    const token = await requestPasswordReset("a@example.com");
    const insert = stub.calls.find((c) => /INSERT INTO password_resets/i.test(c.text));

    assert.equal(insert.params.includes(token), false, "the token must not be stored");
    assert.equal(insert.params[1], createHash("sha256").update(token).digest("hex"));
  } finally {
    stub.restore();
  }
});

// Answering differently for a known and an unknown address turns this endpoint
// into a membership test: submit a list, keep the ones that behave differently.
// The service says "nothing to send" the same way in both cases.
test("an unknown address yields no token and no row", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await requestPasswordReset("nobody@example.com"), null);
    assert.equal(
      stub.calls.some((c) => /INSERT INTO password_resets/i.test(c.text)),
      false
    );
  } finally {
    stub.restore();
  }
});

// Resetting a password onto an account that has none would ATTACH one — a way to
// add a permanent credential to an account whose owner only ever proved
// themselves through Google.
test("a Google-only account gets no reset token", async () => {
  const stub = stubPoolQuery(pool, (text) =>
    /FROM users/i.test(text) ? { rows: [{ id: 9, password_hash: null }] } : { rows: [] }
  );
  try {
    assert.equal(await requestPasswordReset("g@example.com"), null);
  } finally {
    stub.restore();
  }
});

// ── Spending it ─────────────────────────────────────────────────────────────

const resetWith = (rows) =>
  stubPoolConnect(pool, (text) => {
    if (/FROM password_resets/i.test(text)) return { rows };
    if (/UPDATE users/i.test(text)) return { rows: [{ id: 4, email: "a@example.com", role: "student" }] };
    return { rows: [] };
  });

test("a valid token sets the password and returns the account", async () => {
  const db = resetWith([{ id: 1, user_id: 4 }]);
  try {
    const { user } = await resetPassword("t".repeat(64), "a-long-enough-password");
    assert.equal(user.id, 4);
  } finally {
    db.restore();
  }
});

// The lookup is what enforces single use and expiry, so it has to carry both
// conditions — and FOR UPDATE, or two confirms of the same token both see it
// unused.
test("the token lookup requires it to be unused, unexpired and locked", async () => {
  const db = resetWith([{ id: 1, user_id: 4 }]);
  try {
    await resetPassword("t".repeat(64), "a-long-enough-password");
    const lookup = db.calls.find((c) => /FROM password_resets/i.test(c.text));
    assert.match(lookup.text, /used_at IS NULL/);
    assert.match(lookup.text, /expires_at > NOW\(\)/);
    assert.match(lookup.text, /FOR UPDATE/);
  } finally {
    db.restore();
  }
});

test("an expired or spent token is refused", async () => {
  const db = resetWith([]);
  try {
    await assert.rejects(() => resetPassword("t".repeat(64), "a-long-enough-password"), {
      statusCode: 400,
      code: "INVALID_RESET_TOKEN",
    });
  } finally {
    db.restore();
  }
});

// Someone who asked three times has three live links sitting in their inbox.
// Two of them surviving the reset is two more chances for whoever else can read
// it.
test("every outstanding token for that user is burned, not just the one used", async () => {
  const db = resetWith([{ id: 1, user_id: 4 }]);
  try {
    await resetPassword("t".repeat(64), "a-long-enough-password");
    const burn = db.calls.find((c) => /UPDATE password_resets SET used_at/i.test(c.text));
    assert.match(burn.text, /user_id = \$1 AND used_at IS NULL/);
  } finally {
    db.restore();
  }
});

// Without this the reset is theatre: the JWT lasts seven days, so an attacker
// holding a stolen cookie keeps working access for a week after the owner
// believes they have locked them out.
test("the reset stamps password_changed_at, which ends older sessions", async () => {
  const db = resetWith([{ id: 1, user_id: 4 }]);
  try {
    await resetPassword("t".repeat(64), "a-long-enough-password");
    const update = db.calls.find((c) => /UPDATE users/i.test(c.text));
    assert.match(update.text, /password_changed_at = NOW\(\)/);
  } finally {
    db.restore();
  }
});

test("a short password is refused before anything is written", async () => {
  const db = resetWith([{ id: 1, user_id: 4 }]);
  try {
    await assert.rejects(() => resetPassword("t".repeat(64), "short"), { code: "WEAK_PASSWORD" });
    assert.equal(db.calls.length, 0, "nothing should have been attempted");
  } finally {
    db.restore();
  }
});

// ── The rule that ends the old sessions ─────────────────────────────────────

test("a token minted before the password changed is spent", () => {
  const changedAt = new Date("2026-01-01T12:00:00Z");
  const before = Math.floor(changedAt.getTime() / 1000) - 60;
  assert.equal(tokenPredatesPasswordChange({ password_changed_at: changedAt }, before), true);
});

test("a token minted after it is fine", () => {
  const changedAt = new Date("2026-01-01T12:00:00Z");
  const after = Math.floor(changedAt.getTime() / 1000) + 60;
  assert.equal(tokenPredatesPasswordChange({ password_changed_at: changedAt }, after), false);
});

// iat is whole seconds and the column has sub-second precision, so the token the
// reset itself hands back would otherwise be refused the instant it was issued.
test("a token minted in the same second as the change survives", () => {
  const changedAt = new Date("2026-01-01T12:00:00.750Z");
  const sameSecond = Math.floor(changedAt.getTime() / 1000);
  assert.equal(tokenPredatesPasswordChange({ password_changed_at: changedAt }, sameSecond), false);
});

test("an account that has never changed its password accepts any token", () => {
  assert.equal(tokenPredatesPasswordChange({ password_changed_at: null }, 0), false);
});

test("a token with no iat at all is refused once a change exists", () => {
  assert.equal(
    tokenPredatesPasswordChange({ password_changed_at: new Date() }, undefined),
    true,
    "an unplaceable token cannot be shown to postdate the change"
  );
});

// ── Changing it while signed in ─────────────────────────────────────────────

test("the current password must be given", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ password_hash: "$2a$12$notmatching" }] }));
  try {
    await assert.rejects(() => changePassword(4, "wrong", "a-long-enough-password"), {
      statusCode: 401,
    });
  } finally {
    stub.restore();
  }
});

test("an account with no password is told to use Google", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ password_hash: null }] }));
  try {
    await assert.rejects(() => changePassword(9, "anything", "a-long-enough-password"), {
      code: "NO_PASSWORD_SET",
    });
  } finally {
    stub.restore();
  }
});

// ── Editing a profile ───────────────────────────────────────────────────────

// The only write a user makes to their own row, so what it can reach matters
// more than usual: role and is_active must not be among it.
test("the profile update touches only the display name and avatar", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 4 }] }));
  try {
    await updateProfile(4, { displayName: "אברהם", avatarUrl: "https://example.com/a.png", role: "admin" });
    const { text } = stub.calls[0];
    assert.match(text, /display_name/);
    assert.match(text, /avatar_url/);
    assert.equal(/\brole\b\s*=/.test(text), false, "role must not be reachable from a profile edit");
    assert.equal(/is_active\s*=/.test(text), false);
  } finally {
    stub.restore();
  }
});

test("a blank display name is refused rather than saved", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 4 }] }));
  try {
    await assert.rejects(() => updateProfile(4, { displayName: "   " }), { statusCode: 400 });
  } finally {
    stub.restore();
  }
});
