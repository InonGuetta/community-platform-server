import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { instrument } from "../db/pool.js";

// Regression tests for a bug that took the whole application down while every
// other test passed.
//
// db/pool.js wraps pool.query and pool.connect to time and log every statement.
// Both wrappers were written for the promise form only. But pg uses the
// CALLBACK form internally: Pool.query() checks out a client with
// `this.connect((err, client) => …)` and then runs `client.query(text, values,
// cb)`. Each wrapper swallowed that callback, so the promise pg handed back
// never settled — every query in the app hung forever, with no error and no
// timeout to surface it. Login simply spun until the browser gave up.
//
// Nothing caught it because the rest of the suite stubs pool.query outright and
// so never executes the wrapper at all. These tests drive the wrapper directly,
// over a fake pg that behaves the way the real one does, so they need no
// database and run in CI like everything else.
//
// The property being protected is narrow and permanent: **the instrumentation
// must be transparent to pg's callback API.**

// Behaves as pg does: promise-style when given none, callback-style when given
// a function in any argument position.
const fakePg = () => {
  const calls = [];
  const query = (...args) => {
    calls.push(args);
    const callback = args.find((a) => typeof a === "function");
    const result = { rows: [{ ok: 1 }], rowCount: 1 };
    if (callback) {
      setImmediate(() => callback(null, result));
      return undefined; // pg returns nothing in the callback form
    }
    return Promise.resolve(result);
  };
  return { query, calls };
};

// A hang is the failure being guarded against, so waiting forever would make
// the test hang too rather than report.
const settlesWithin = (promise, ms = 1500) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`never settled within ${ms}ms — the callback was dropped`)), ms)
    ),
  ]);

test("the promise form still resolves, and is passed through unchanged", async () => {
  const pg = fakePg();
  const wrapped = instrument("test", pg.query);

  const result = await settlesWithin(wrapped("SELECT 1"));

  assert.deepEqual(result.rows, [{ ok: 1 }]);
  assert.deepEqual(pg.calls[0], ["SELECT 1", undefined]);
});

test("parameters reach the driver untouched", async () => {
  const pg = fakePg();
  const wrapped = instrument("test", pg.query);

  await settlesWithin(wrapped("SELECT $1::int", [42]));

  assert.deepEqual(pg.calls[0], ["SELECT $1::int", [42]]);
});

test("the callback form invokes its callback — the bug that hung every query", async () => {
  const pg = fakePg();
  const wrapped = instrument("test", pg.query);

  // Exactly the shape pg's Pool.query() uses against a pooled client.
  const result = await settlesWithin(
    new Promise((resolve, reject) => {
      wrapped("SELECT 1", [], (err, res) => (err ? reject(err) : resolve(res)));
    })
  );

  assert.deepEqual(result.rows, [{ ok: 1 }]);
});

test("a callback in the second position is honoured too", async () => {
  // pg allows query(text, callback) with no parameters. A wrapper that only
  // checked the third argument would drop this one.
  const pg = fakePg();
  const wrapped = instrument("test", pg.query);

  const result = await settlesWithin(
    new Promise((resolve, reject) => {
      wrapped("SELECT 1", (err, res) => (err ? reject(err) : resolve(res)));
    })
  );

  assert.deepEqual(result.rows, [{ ok: 1 }]);
});

test("the callback form is not wrapped at all, so it cannot be double-logged", async () => {
  // pg's internal path is already timed by the outer pool.query wrapper. The
  // passthrough must hand the driver the very arguments it was given.
  const pg = fakePg();
  const wrapped = instrument("test", pg.query);
  const callback = () => {};

  wrapped("SELECT 1", [7], callback);

  assert.equal(pg.calls[0].length, 3);
  assert.equal(pg.calls[0][2], callback, "the driver must receive the original callback");
});

test("a rejection still propagates, and is not swallowed by the timing wrapper", async () => {
  const boom = new Error("syntax error at or near \"SELCT\"");
  const wrapped = instrument("test", async () => { throw boom; });

  await assert.rejects(() => settlesWithin(wrapped("SELCT 1")), (err) => err === boom);
});

test("an error in the callback form reaches the callback rather than throwing", async () => {
  const boom = new Error("connection terminated");
  const wrapped = instrument("test", (text, params, cb) => setImmediate(() => cb(boom)));

  const received = await settlesWithin(
    new Promise((resolve) => wrapped("SELECT 1", [], (err) => resolve(err)))
  );

  assert.equal(received, boom);
});
