import "./setup.js";
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import request from "supertest";
import jwt from "jsonwebtoken";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { scrubEvent, scrubText, initMonitoring, captureError, flushMonitoring, monitoringEnabled } from "../lib/monitoring.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// External error reporting (PRD NFR-1). The real SDK, sending to a fake Sentry
// on this machine — so what is asserted is what would actually leave the
// server, byte for byte, not what we hope the scrubber does.

const received = [];
let fakeSentry;

before(async () => {
  fakeSentry = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
      received.push(body.toString("utf8"));
      res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await new Promise((resolve) => fakeSentry.listen(0, "127.0.0.1", resolve));
});

after(async () => {
  delete process.env.SENTRY_DSN;
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
  await new Promise((resolve) => fakeSentry.close(resolve));
});

test("with no DSN nothing starts, and reporting is a silent no-op", () => {
  delete process.env.SENTRY_DSN;
  assert.equal(initMonitoring("api"), false);
  assert.equal(monitoringEnabled(), false);
  captureError(new Error("ignored"));
});

test("the scrubber removes the person and anything personal in a message", () => {
  const event = scrubEvent({
    user: { id: 5, email: "a@b.co" },
    request: { url: "/api/x?email=a@b.co", cookies: { token: "x" }, data: "{}" },
    server_name: "host-1",
    breadcrumbs: [{ message: "login a@b.co" }],
    message: "for rabbi@example.org",
    exception: { values: [{ value: 'Key (email)=(rabbi@example.org) exists; Bearer eyJhbGc.eyJpZCI6MX0.sig; sk_live_abc123' }] },
  });
  assert.equal(event.user, undefined);
  assert.equal(event.request, undefined);
  assert.equal(event.server_name, undefined);
  assert.deepEqual(event.breadcrumbs, []);
  assert.equal(event.message, "for [email]");
  assert.equal(event.exception.values[0].value, "Key (email)=([email]) exists; Bearer [token]; [key]");
  assert.equal(scrubText(null), "");
});

test("an unexpected 500 reaches Sentry with its path and request id — and nothing personal", async () => {
  const { port } = fakeSentry.address();
  process.env.SENTRY_DSN = `http://publickey@127.0.0.1:${port}/1`;
  assert.equal(initMonitoring("api"), true);

  // Imported after the DSN is set, like server.js orders it.
  const { createApp } = await import("../app.js");
  const app = createApp();
  const token = jwt.sign({ id: 9, email: "student@example.org", role: "student" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  const stub = stubPoolQuery(pool, (text) => {
    if (/FROM users/i.test(text)) return { rows: [{ id: 9, email: "student@example.org", role: "student" }] };
    throw new Error("broke while reading for student@example.org");
  });
  try {
    const res = await request(app)
      .get("/api/media/12?search=secret-words")
      .set("Cookie", `token=${token}`)
      .set("User-Agent", "test-agent");
    assert.equal(res.status, 500);
  } finally {
    stub.restore();
  }
  await flushMonitoring(5000);

  const sent = received.join("\n");
  assert.ok(sent.includes("broke while reading for [email]"), "the error itself was sent");
  assert.ok(sent.includes("/api/media/12"), "with the path");
  assert.ok(sent.includes('"requestId"'), "and the request id that finds it in our log");
  assert.ok(sent.includes('"http-500"'));
  for (const personal of ["student@example.org", "secret-words", token, "test-agent", '"cookies"', '"user"']) {
    assert.ok(!sent.includes(personal), `must not send ${personal}`);
  }
});
