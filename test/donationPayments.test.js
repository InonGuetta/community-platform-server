import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { stripe, paymentsConfigured } from "../lib/stripeClient.js";
import { statusFromIntent } from "../services/servicesDonations.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Taking a real donation (PRD PAY-1, PAY-2): refusing plainly while the keys
// are placeholders, handing the browser the publishable key with the intent,
// and bringing a donation in line with Stripe after the donor pays.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const DONOR = { id: 13, email: "d@example.com", role: "student", is_active: true };
const cookie = `token=${jwt.sign({ id: DONOR.id, email: DONOR.email, role: DONOR.role }, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const REAL_SECRET = `sk_test_${"a".repeat(30)}`;
const REAL_PUBLISHABLE = `pk_test_${"b".repeat(30)}`;

const withKeys = async (secret, publishable, fn) => {
  const saved = [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PUBLISHABLE_KEY];
  process.env.STRIPE_SECRET_KEY = secret;
  if (publishable === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
  else process.env.STRIPE_PUBLISHABLE_KEY = publishable;
  try {
    return await fn();
  } finally {
    [process.env.STRIPE_SECRET_KEY, process.env.STRIPE_PUBLISHABLE_KEY] = saved;
    if (saved[1] === undefined) delete process.env.STRIPE_PUBLISHABLE_KEY;
  }
};

test("payments count as set up only with two real keys from the same mode", async () => {
  assert.equal(await withKeys("sk_test_...", "pk_test_...", paymentsConfigured), false);
  assert.equal(await withKeys(REAL_SECRET, undefined, paymentsConfigured), false);
  assert.equal(await withKeys(REAL_SECRET, REAL_PUBLISHABLE, paymentsConfigured), true);
  assert.equal(await withKeys(REAL_SECRET, `pk_live_${"b".repeat(30)}`, paymentsConfigured), false);
});

const db = (donation) =>
  stubPoolQuery(pool, (text) => {
    if (/FROM users/.test(text) && !/donations/.test(text)) return { rows: [DONOR] };
    if (/INSERT INTO donations/.test(text)) return { rows: [{ id: 41 }] };
    if (/UPDATE donations SET stripe_payment_intent/.test(text)) return { rows: [{ id: 41, status: "pending" }] };
    if (/SELECT \* FROM donations WHERE id=\$1 AND donor_id=\$2/.test(text)) return { rows: donation ? [donation] : [] };
    if (/UPDATE donations d SET status/.test(text)) return { rows: [{ ...donation, status: "completed", donor_email: null }] };
    return { rows: [] };
  });

test("with placeholder keys a donation is refused plainly, and nothing is written", async () => {
  const stub = db();
  try {
    const res = await withKeys("sk_test_...", "pk_test_...", () =>
      request(app).post("/api/donations/create-intent").set("Cookie", cookie).send({ amountCents: 5000, type: "one_time" })
    );
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "PAYMENTS_NOT_CONFIGURED");
    assert.equal(stub.calls.some((c) => /INSERT INTO donations/.test(c.text)), false);
  } finally {
    stub.restore();
  }
});

test("an intent comes back with the key the browser starts Stripe.js with", async () => {
  const stub = db();
  const original = stripe.paymentIntents.create;
  stripe.paymentIntents.create = async () => ({ id: "pi_1", client_secret: "pi_1_secret_x" });
  try {
    const res = await withKeys(REAL_SECRET, REAL_PUBLISHABLE, () =>
      request(app).post("/api/donations/create-intent").set("Cookie", cookie).send({ amountCents: 5000, type: "one_time" })
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.publishableKey, REAL_PUBLISHABLE);
    assert.equal(res.body.clientSecret, "pi_1_secret_x");
  } finally {
    stripe.paymentIntents.create = original;
    stub.restore();
  }
});

test("Stripe's states map to the ledger's, and an untried intent is still undecided", () => {
  assert.equal(statusFromIntent({ status: "succeeded" }), "completed");
  assert.equal(statusFromIntent({ status: "canceled" }), "failed");
  assert.equal(statusFromIntent({ status: "requires_payment_method", last_payment_error: { code: "card_declined" } }), "failed");
  assert.equal(statusFromIntent({ status: "requires_payment_method" }), null);
  assert.equal(statusFromIntent({ status: "processing" }), null);
});

const PENDING = { id: 41, donor_id: DONOR.id, status: "pending", stripe_payment_intent: "pi_1", amount_cents: 5000, currency: "ILS" };

test("after paying, the donor's donation is brought in line with Stripe", async () => {
  const stub = db(PENDING);
  const original = stripe.paymentIntents.retrieve;
  let asked = null;
  stripe.paymentIntents.retrieve = async (id) => { asked = id; return { id, status: "succeeded" }; };
  try {
    const res = await request(app).post("/api/donations/41/sync").set("Cookie", cookie);
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "completed");
    assert.equal(asked, "pi_1");
    const lookup = stub.calls.find((c) => /donor_id=\$2/.test(c.text));
    assert.deepEqual(lookup.params.map(Number), [41, DONOR.id]);
  } finally {
    stripe.paymentIntents.retrieve = original;
    stub.restore();
  }
});

test("an intent the donor has not finished leaves the donation pending", async () => {
  const stub = db(PENDING);
  const original = stripe.paymentIntents.retrieve;
  stripe.paymentIntents.retrieve = async (id) => ({ id, status: "requires_payment_method" });
  try {
    const res = await request(app).post("/api/donations/41/sync").set("Cookie", cookie);
    assert.equal(res.body.status, "pending");
    assert.equal(stub.calls.some((c) => /UPDATE donations d SET status/.test(c.text)), false);
  } finally {
    stripe.paymentIntents.retrieve = original;
    stub.restore();
  }
});

test("another donor's donation is a 404, and Stripe is not asked", async () => {
  const stub = db(null);
  const original = stripe.paymentIntents.retrieve;
  let asked = false;
  stripe.paymentIntents.retrieve = async () => { asked = true; return {}; };
  try {
    const res = await request(app).post("/api/donations/41/sync").set("Cookie", cookie);
    assert.equal(res.status, 404);
    assert.equal(asked, false);
  } finally {
    stripe.paymentIntents.retrieve = original;
    stub.restore();
  }
});
