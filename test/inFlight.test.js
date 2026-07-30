import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { withExclusive } from "../lib/inFlight.js";

const defer = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms));

// The AI endpoints run synchronously inside the request and take minutes on a
// long transcript — long enough for a user to press the button again, and each
// press is a sequence of paid GPT-4o calls.

test("a second concurrent call is refused and the work runs once", async () => {
  let runs = 0;
  const work = async () => { runs++; return defer(60, "done"); };

  const first = withExclusive("media:1", work);
  const second = await withExclusive("media:1", work).catch((err) => err);

  assert.equal(second.statusCode, 409);
  assert.equal(runs, 1, "the expensive call must not have been made twice");
  assert.equal(await first, "done", "the original call is unaffected");
});

test("the lock is released once the work finishes", async () => {
  await withExclusive("media:2", () => defer(1));
  await assert.doesNotReject(() => withExclusive("media:2", () => defer(1)));
});

test("the lock is released even when the work throws", async () => {
  await withExclusive("media:3", async () => { throw new Error("boom"); }).catch(() => {});
  await assert.doesNotReject(
    () => withExclusive("media:3", () => defer(1)),
    "a failed run must not leave the media permanently locked"
  );
});

test("different media are independent", async () => {
  const first = withExclusive("media:10", () => defer(40));
  await assert.doesNotReject(() => withExclusive("media:11", () => defer(1)));
  await first;
});

test("different operations on the same media are independent", async () => {
  const fixing = withExclusive("fix-hebrew:5", () => defer(40));
  await assert.doesNotReject(() => withExclusive("key-point-headings:5", () => defer(1)));
  await fixing;
});

test("the caller's message reaches the client", async () => {
  const running = withExclusive("media:20", () => defer(40), "Hebrew correction is already running");
  const err = await withExclusive("media:20", () => defer(1), "Hebrew correction is already running").catch((e) => e);
  assert.match(err.message, /already running/);
  await running;
});
