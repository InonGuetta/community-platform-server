import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp, API_ROUTERS } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { optionalId, PG_INT_MAX } from "../lib/validate.js";
import * as controllersTranscripts from "../controllers/controllersTranscripts.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The guards at the edge of the application: what a request may say, and what it
// may not. Everything here answers 400 — and every one of these used to answer
// 500, or worse, be accepted.
//
// Driven through the real app rather than by calling the guards directly,
// wherever a guard's position in the chain is part of what is being asserted. A
// unit test on validateIntParam would pass just as happily if the middleware were
// mounted on the wrong verb, or after the handler it protects.
//
// Importing app.js reaches servicesAdmin, which constructs the Bull queues, whose
// Redis clients retry on a timer forever against setup.js's dead port. They keep
// the event loop alive, so this file closes what its imports opened.
after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const asUser = ({ id = 7, role = "lecturer" } = {}) => {
  const token = jwt.sign({ id, email: "u@example.com", role }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
  return { token, row: { id, email: "u@example.com", role } };
};

// verifyToken re-reads the user on every request, so an authenticated call always
// spends one query before the handler's own. This answers that one and lets the
// caller decide the rest.
const authed = (rest = () => ({ rows: [] })) => {
  const { token, row } = asUser();
  let call = 0;
  const stub = stubPoolQuery(pool, (text, params) =>
    call++ === 0 ? { rows: [row] } : rest(text, params)
  );
  return { token, stub };
};

// ── Ids that Postgres cannot store ──────────────────────────────────────────
//
// The digit test alone let "99999999999" through, and INT4 then answered "value
// out of range for type integer" — a 500 from the guard whose entire purpose is
// turning a malformed id into a 400. Driven through a real route because
// validateIntParam runs AFTER verifyToken here, and an anonymous probe would get
// a 401 and prove nothing about the id at all.

test("an id past INT4 is refused as a bad request, not left to Postgres", async () => {
  const { token, stub } = authed(() => {
    throw new Error("reached the database with an unstorable id");
  });
  try {
    const res = await request(app)
      .get(`/api/media/${PG_INT_MAX + 1}`)
      .set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /Invalid id/);
  } finally {
    stub.restore();
  }
});

test("zero is refused — no SERIAL ever issues it", async () => {
  const { token, stub } = authed(() => {
    throw new Error("spent a query discovering that 0 is not a row");
  });
  try {
    const res = await request(app).get("/api/media/0").set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

test("an ordinary id still passes the guard", async () => {
  // The other half of the contract: a bound that also rejects real ids would be
  // caught by nothing above.
  const { token, stub } = authed(() => ({
    rows: [{ id: 1, is_published: true, s3_key: "local/x.mp3", title: "x" }],
  }));
  try {
    const res = await request(app).get("/api/media/1").set("Cookie", `token=${token}`);
    assert.notEqual(res.status, 400, "a valid id must not be rejected by the range guard");
  } finally {
    stub.restore();
  }
});

// The same id arrives through the body as well as the path, and a guard on one
// door only is not a guard — hence the shared bound.
test("optionalId applies the same ceiling as the route guard", () => {
  assert.equal(optionalId(PG_INT_MAX, "courseId"), PG_INT_MAX, "the boundary itself is storable");
  assert.throws(() => optionalId(PG_INT_MAX + 1, "courseId"), { statusCode: 400 });
});

// ── transcript_status is not the client's to write ──────────────────────────

test("a status sent in the body never reaches the UPDATE", async () => {
  // The row the ownership check reads, then the transcript UPDATE.
  const calls = [];
  const stub = stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM media_items/i.test(text)) {
      return { rows: [{ id: 5, uploader_id: 7, is_published: true }] };
    }
    return { rows: [{ media_id: 5, status: "pending" }] };
  });

  try {
    const req = {
      user: { id: 7, role: "lecturer" },
      params: { mediaId: "5" },
      body: { editedText: "טקסט מתוקן", status: "done" },
    };
    const res = { statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };

    await controllersTranscripts.updateTranscript(req, res);

    const update = calls.find((c) => /UPDATE transcripts/i.test(c.text));
    assert.ok(update, "the edit should still have been written");
    assert.ok(
      update.params.includes("טקסט מתוקן"),
      "the fields a lecturer may edit must still go through"
    );
    assert.ok(
      !update.params.includes("done"),
      "status is the pipeline's to write — a body must never be able to set it"
    );
  } finally {
    stub.restore();
  }
});

// ── A search is billed by size, not only by frequency ───────────────────────

test("an oversized search query is refused before anything is billed", async () => {
  const { token, stub } = authed(() => {
    throw new Error("reached the database for a query that should have been refused");
  });
  try {
    const res = await request(app)
      .get(`/api/transcripts/search?q=${"א".repeat(301)}`)
      .set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /300 characters/);
  } finally {
    stub.restore();
  }
});

test("a repeated q parameter is refused rather than read as an array", async () => {
  // Express turns ?q=a&q=b into an array, which has a .length that means
  // something entirely different from a string's.
  const { token, stub } = authed(() => ({ rows: [] }));
  try {
    const res = await request(app)
      .get("/api/transcripts/search?q=a&q=b")
      .set("Cookie", `token=${token}`);
    assert.equal(res.status, 400);
  } finally {
    stub.restore();
  }
});

// There is deliberately no "and an ordinary question still goes through" case
// here. A query that passes the cap continues into embedQuery, which calls
// OpenAI for real — this suite's whole premise is that it needs no database,
// Redis, S3 or API key, and an outbound request in CI would break that for every
// contributor and every fork's pull request. The cap's number is pinned by the
// message assertion above instead, which fails if it is ever tightened.

// ── Donations ───────────────────────────────────────────────────────────────
//
// Both cases below are refused before servicesDonations is reached, which is what
// keeps this test off the network: neither one ever constructs a payment intent.

test("a donation type outside the enum is a 400, not an enum error from Postgres", async () => {
  const { token, stub } = authed(() => {
    throw new Error("reached the database with a type the column cannot hold");
  });
  try {
    const res = await request(app)
      .post("/api/donations/create-intent")
      .set("Cookie", `token=${token}`)
      .send({ type: "sponsorship", amountCents: 500, currency: "ILS" });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /one_time/);
  } finally {
    stub.restore();
  }
});

test("a non-string currency is a 400, not a TypeError", async () => {
  // currency.toUpperCase() on a number threw from inside the very block whose job
  // is to answer 400, and the handler returned 500 instead.
  const { token, stub } = authed(() => ({ rows: [] }));
  try {
    const res = await request(app)
      .post("/api/donations/create-intent")
      .set("Cookie", `token=${token}`)
      .send({ type: "one_time", amountCents: 500, currency: 5 });
    assert.equal(res.status, 400);
    assert.match(res.body.message, /currency/i);
  } finally {
    stub.restore();
  }
});

// ── The recording endpoint is gone, and stays gone ──────────────────────────

test("no route accepts a recording key", () => {
  // Asserted against the mounted routers rather than a file, so re-adding the
  // handler anywhere — under any prefix — fails here. It was removed because
  // nothing called it while it let any host write an arbitrary bucket key onto
  // their own session; the column it wrote to is deliberately still in the schema.
  const paths = [];
  for (const [prefix, router] of API_ROUTERS) {
    for (const layer of router.stack ?? []) {
      if (layer.route) paths.push(prefix + layer.route.path);
    }
  }
  assert.ok(paths.length > 40, "the inventory must actually be populated");
  assert.equal(
    paths.some((p) => /recording/i.test(p)),
    false,
    "recording has no client and no caller — see ARCHITECTURE.md's known-debt list"
  );
});
