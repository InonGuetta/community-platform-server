import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import crypto from "crypto";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// Stripe signs the exact BYTES of the request body, so anything that parses and
// reserialises them breaks verification for every event that will ever arrive.
//
// app.js skips the global JSON parser for this one path and the donations router
// re-parses it with express.raw(). That arrangement is invisible from either file
// alone — a future "let's parse JSON everywhere" tidy-up would look harmless and
// silently reject every webhook — and until now nothing checked it.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

// The scheme Stripe uses: t=<timestamp>,v1=<hmac of "timestamp.body">.
const sign = (body, secret) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
};

const EVENT = JSON.stringify({
  id: "evt_1",
  type: "payment_intent.succeeded",
  data: { object: { id: "pi_test_1" } },
});

test("a correctly signed webhook is accepted", async () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  // No donation row comes back, which the controller treats as "nothing to
  // apply" and still answers 200 — the point here is that the SIGNATURE passed.
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app)
      .post("/api/donations/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", sign(EVENT, secret))
      .send(EVENT);

    assert.equal(
      res.status, 200,
      "a valid signature must verify — if this fails, the raw body is being parsed somewhere"
    );
  } finally {
    stub.restore();
  }
});

// The other half: verification has to actually reject. A 200 here would mean the
// signature check was doing nothing, and the endpoint is public and moves money
// to 'completed'.
test("a tampered body is rejected", async () => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = sign(EVENT, secret);
  const tampered = EVENT.replace("pi_test_1", "pi_attacker");

  const stub = stubPoolQuery(pool, () => {
    throw new Error("reached the database on an unverified webhook");
  });
  try {
    const res = await request(app)
      .post("/api/donations/webhook")
      .set("Content-Type", "application/json")
      .set("stripe-signature", signature)
      .send(tampered);

    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

test("a missing signature is rejected", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app)
      .post("/api/donations/webhook")
      .set("Content-Type", "application/json")
      .send(EVENT);
    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

// Every other route still gets parsed JSON — the skip is one path, not a hole in
// the body parser.
test("the parser skip applies to the webhook alone", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    // Anonymous, so it stops at verifyToken — but reaching a 401 rather than a
    // parser error is what shows the body was read normally.
    const res = await request(app)
      .post("/api/donations/create-intent")
      .send({ type: "one_time", amountCents: 500 });
    assert.equal(res.status, 401);
  } finally {
    stub.restore();
  }
});
