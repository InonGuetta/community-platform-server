import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { errorHandler } from "../middleware/errorHandler.js";

const run = (err) => {
  const sent = {};
  const res = {
    headersSent: false,
    status(code) { sent.status = code; return this; },
    json(body) { sent.body = body; return this; },
  };
  errorHandler(err, { method: "POST", originalUrl: "/api/auth/login" }, res, () => { sent.next = true; });
  return sent;
};

test("an operational AppError keeps its own status and message", () => {
  const sent = run({ expose: true, statusCode: 401, message: "Invalid credentials" });
  assert.equal(sent.status, 401);
  assert.deepEqual(sent.body, { message: "Invalid credentials" });
});

// These are quoted verbatim from pg and pg-pool. They are the errors the
// timeouts configured in db/pool.js actually raise, and they carry no `code`
// — so if the message match is wrong they fall through to the generic branch
// and answer 500. That matters beyond the status number: the client retries a
// 503 (the request was never processed) and does not retry a 500, so getting
// this wrong turned a cold database connection into a failed login the user
// had to click through by hand.
test("a pg connection/timeout failure is a 503, not a 500", () => {
  const messages = [
    "Connection terminated unexpectedly",
    "Connection terminated due to connection timeout",
    "timeout expired",
    "timeout exceeded when trying to connect",
    "Query read timeout",
    "Client has encountered a connection error and is not queryable",
    "read ECONNRESET",
  ];

  for (const message of messages) {
    const sent = run(new Error(message));
    assert.equal(sent.status, 503, `"${message}" should be retriable`);
    assert.match(sent.body.message, /retry/i);
  }
});

test("a driver/socket error code is a 503 whatever the message says", () => {
  for (const code of ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "57P01", "08006"]) {
    const sent = run(Object.assign(new Error("something opaque"), { code }));
    assert.equal(sent.status, 503, `${code} should be retriable`);
  }
});

// The other half of the contract: a genuine fault must stay a 500 so the client
// does not replay a request the server really did process.
test("an unexpected error is still a 500", () => {
  const sent = run(new TypeError("x is not a function"));
  assert.equal(sent.status, 500);
  assert.equal(sent.body.message, "Internal server error");
});

test("a syntax error in SQL is the app's fault, not the connection's", () => {
  const sent = run(Object.assign(new Error('syntax error at or near "SELCT"'), { code: "42601" }));
  assert.equal(sent.status, 500);
});

test("nothing is written once the response has started", () => {
  const sent = {};
  const res = { headersSent: true, status() { sent.status = 500; return this; }, json() { return this; } };
  errorHandler(new Error("late"), { method: "GET", originalUrl: "/x" }, res, () => { sent.next = true; });
  assert.equal(sent.next, true, "handed to express so it can close the connection");
  assert.equal(sent.status, undefined);
});
