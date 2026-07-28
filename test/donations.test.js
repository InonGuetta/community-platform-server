import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { updateDonationStatus } from "../services/servicesDonations.js";

// The webhook's 200-vs-500 decision is driven entirely by what this returns:
// null means "nothing to do, do not ask Stripe to retry", a throw means "a real
// failure, please retry". Getting that backwards produced a permanent retry
// storm over an event that could never succeed.

test("the update refuses to walk back a completed donation", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await updateDonationStatus("pi_1", "failed");
    const { text, params } = stub.calls[0];
    assert.match(text, /status\s*<>\s*'completed'/, "a late payment_failed must not undo a paid donation");
    assert.deepEqual(params, ["failed", "pi_1"]);
  } finally {
    stub.restore();
  }
});

test("an unknown payment intent returns null instead of throwing", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await updateDonationStatus("pi_unknown", "completed"), null);
  } finally {
    stub.restore();
  }
});

test("a redelivered event applies nothing and reports it", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await updateDonationStatus("pi_1", "completed"), null);
  } finally {
    stub.restore();
  }
});

test("a real update returns the row", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 3, status: "completed" }] }));
  try {
    assert.equal((await updateDonationStatus("pi_1", "completed")).id, 3);
  } finally {
    stub.restore();
  }
});

// The database being briefly unreachable is exactly when a Stripe retry helps,
// so this one must NOT be swallowed into a 200.
test("a database failure propagates so Stripe retries", async () => {
  const stub = stubPoolQuery(pool, () => {
    const err = new Error("Connection terminated");
    err.code = "ECONNRESET";
    throw err;
  });
  try {
    await assert.rejects(() => updateDonationStatus("pi_1", "completed"), { code: "ECONNRESET" });
  } finally {
    stub.restore();
  }
});
