import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp, API_ROUTERS } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The first tests that go through the real chain: helmet, the body parsers,
// cookie-parser, passport, the routers, verifyToken/requireRole, the controller
// and the error handler, in the order production uses them.
//
// Nothing here reaches a database. `pool.query` is stubbed per test, which is
// deliberately the ONLY thing replaced: everything above the pg driver is the
// real code, so a route that loses its verifyToken, a role check applied to the
// wrong verb, or a middleware inserted in the wrong order all fail here. Testing
// against a real Postgres would move the boundary one layer lower for no gain on
// those questions, and would cost CI a database, migrations and seed data.
//
// Importing app.js pulls in servicesAdmin, which imports the two Bull queues,
// which open Redis connections that retry forever against the placeholder URL.
// They keep the event loop alive, so the run has to close them or `node --test`
// hangs after the last assertion instead of exiting.
after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

// ── Route inventory ─────────────────────────────────────────────────────────
// Walked from the mounted routers rather than written out by hand. A new route
// is covered by the sweep below the moment it is added — which is the whole
// point, since a route nobody remembered to protect is exactly the one a
// hand-maintained list would omit.
const allRoutes = () => {
  const routes = [];
  for (const [prefix, router] of API_ROUTERS) {
    for (const layer of router.stack ?? []) {
      if (!layer.route) continue;
      for (const method of Object.keys(layer.route.methods ?? {})) {
        routes.push({ method, path: prefix + layer.route.path, prefix });
      }
    }
  }
  return routes;
};

// ":id" → "1" so the path resolves. validateIntParam rejects anything else with
// a 400, which would mask the 401 this is checking for.
const concrete = (path) => path.replace(/:[A-Za-z]+/g, "1");

// Reachable without a session, each for a stated reason. Anything not on this
// list must answer 401 to an anonymous caller.
const PUBLIC = new Set([
  "post /api/auth/register",   // creating the account IS the way in
  "post /api/auth/login",
  "get /api/auth/google",            // redirects the browser to Google
  "get /api/auth/google/callback",   // Google redirects back here
  // Stripe calls this server-to-server with no cookie. It authenticates by
  // signature instead, which the controller verifies itself.
  "post /api/donations/webhook",
]);

const key = (r) => `${r.method} ${r.path}`;

test("the route inventory is actually populated", () => {
  // Guards every sweep below: if the router internals change shape and this
  // returns nothing, the tests would all pass while checking nothing at all.
  const routes = allRoutes();
  assert.ok(routes.length > 40, `expected the full API, found ${routes.length} routes`);
  for (const [prefix] of API_ROUTERS) {
    assert.ok(routes.some((r) => r.prefix === prefix), `no routes found under ${prefix}`);
  }
});

test("every route requires a session unless it is deliberately public", async (t) => {
  // No stub: a 401 must be decided before anything touches the database. If a
  // route gets far enough to query, this throws and the test says so.
  const stub = stubPoolQuery(pool, () => {
    throw new Error("reached the database without authenticating");
  });

  try {
    for (const route of allRoutes()) {
      if (PUBLIC.has(key(route))) continue;

      const res = await request(app)[route.method](concrete(route.path));

      await t.test(`${route.method.toUpperCase()} ${route.path}`, () => {
        assert.equal(
          res.status, 401,
          `answered ${res.status}; every non-public route must reject an anonymous caller`
        );
      });
    }
  } finally {
    stub.restore();
  }
});

test("a route listed as public is in fact reachable", async () => {
  // The other half of the contract. Without this, adding a path to PUBLIC to
  // silence the sweep above would go unnoticed — the list has to be justified
  // by behaviour, not by assertion.
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).get("/api/auth/google");
    // 302 to Google's consent screen. Anything else means the route stopped
    // being public and PUBLIC is now lying.
    assert.equal(res.status, 302);
    assert.match(res.headers.location, /accounts\.google\.com/);
  } finally {
    stub.restore();
  }
});

// ── Authenticated requests ──────────────────────────────────────────────────
//
// verifyToken re-reads the user from the database on every request precisely so
// that a deactivated user or a changed role takes effect before the token
// expires. That means signing a token is not enough — the row it looks up has
// to come back too, which is what this stub provides.
const asUser = ({ id = 7, role = "student" } = {}) => {
  const token = jwt.sign({ id, email: "u@example.com", role }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
  return { token, row: { id, email: "u@example.com", role } };
};

const ADMIN_ONLY = [
  { method: "get", path: "/api/users/get-all-users" },
  { method: "post", path: "/api/users/create-user" },
  { method: "delete", path: "/api/users/delete-user/1" },
  { method: "get", path: "/api/admin/stats" },
  { method: "get", path: "/api/admin/queue-status" },
  { method: "get", path: "/api/admin/system-health" },
];

test("a signed-in student is refused the admin-only routes", async (t) => {
  const { token, row } = asUser({ role: "student" });
  // Every query answers with the user row: the only one that runs before the
  // role check is verifyToken's own lookup.
  const stub = stubPoolQuery(pool, () => ({ rows: [row] }));

  try {
    for (const route of ADMIN_ONLY) {
      const res = await request(app)[route.method](route.path).set("Cookie", `token=${token}`);
      await t.test(`${route.method.toUpperCase()} ${route.path}`, () => {
        assert.equal(res.status, 403, `answered ${res.status}, expected a refusal`);
      });
    }
  } finally {
    stub.restore();
  }
});

test("a lecturer cannot reach the admin routes either", async () => {
  const { token, row } = asUser({ role: "lecturer" });
  const stub = stubPoolQuery(pool, () => ({ rows: [row] }));
  try {
    const res = await request(app).get("/api/admin/stats").set("Cookie", `token=${token}`);
    assert.equal(res.status, 403);
  } finally {
    stub.restore();
  }
});

test("a student cannot upload or delete media", async () => {
  const { token, row } = asUser({ role: "student" });
  const stub = stubPoolQuery(pool, () => ({ rows: [row] }));
  try {
    const upload = await request(app).post("/api/media/upload").set("Cookie", `token=${token}`);
    assert.equal(upload.status, 403);

    const remove = await request(app).delete("/api/media/delete/1").set("Cookie", `token=${token}`);
    assert.equal(remove.status, 403);
  } finally {
    stub.restore();
  }
});

test("a tampered token is refused, not merely ignored", async () => {
  const signedElsewhere = jwt.sign({ id: 1, role: "admin" }, "not-the-real-secret");
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 1, role: "admin" }] }));
  try {
    const res = await request(app)
      .get("/api/admin/stats")
      .set("Cookie", `token=${signedElsewhere}`);
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "Invalid token");
  } finally {
    stub.restore();
  }
});

test("a valid token for a user who no longer exists is refused", async () => {
  // The deactivation case: the token is genuine and unexpired, but the row is
  // gone (or is_active=FALSE, which the same query filters on).
  const { token } = asUser({ role: "admin" });
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).get("/api/admin/stats").set("Cookie", `token=${token}`);
    assert.equal(res.status, 401);
  } finally {
    stub.restore();
  }
});

test("the role in the token is ignored in favour of the one in the database", async () => {
  // A token minted while the user was an admin must stop working the moment the
  // row says otherwise — that is the reason verifyToken re-reads at all.
  const token = jwt.sign({ id: 7, email: "u@example.com", role: "admin" }, process.env.JWT_SECRET);
  const stub = stubPoolQuery(pool, () => ({ rows: [{ id: 7, email: "u@example.com", role: "student" }] }));
  try {
    const res = await request(app).get("/api/admin/stats").set("Cookie", `token=${token}`);
    assert.equal(res.status, 403, "the demoted user kept admin access");
  } finally {
    stub.restore();
  }
});

// ── A request that succeeds, end to end ─────────────────────────────────────
test("an authenticated GET /api/notes returns the rows the service read", async () => {
  const { token, row } = asUser({ role: "student" });
  const notes = [{ id: 1, title: "שיעור א", body: "..." }];

  // Two queries run: verifyToken's user lookup, then the notes read. Answer
  // them in order rather than by matching on SQL text, which would couple the
  // test to the exact wording of a statement it is not testing.
  let call = 0;
  const stub = stubPoolQuery(pool, () => (call++ === 0 ? { rows: [row] } : { rows: notes }));

  try {
    const res = await request(app).get("/api/notes").set("Cookie", `token=${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, notes);
    assert.equal(call, 2, "expected exactly the auth lookup and the notes read");
  } finally {
    stub.restore();
  }
});

test("every response carries the request id the logs are keyed by", async () => {
  // The header is what makes a user-reported failure findable in the server
  // log. It is set by middleware, so nothing else would notice it going away.
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    const res = await request(app).get("/api/notes");
    assert.match(res.headers["x-request-id"] ?? "", /^[0-9a-f]{8}$/);
  } finally {
    stub.restore();
  }
});

test("an unexpected error becomes a 500 with a code and no internals", async () => {
  const { token, row } = asUser({ role: "student" });
  let call = 0;
  const stub = stubPoolQuery(pool, () => {
    if (call++ === 0) return { rows: [row] };
    throw new TypeError("x is not a function"); // a genuine fault, not a DB outage
  });

  try {
    const res = await request(app).get("/api/notes").set("Cookie", `token=${token}`);
    assert.equal(res.status, 500);
    assert.equal(res.body.message, "Internal server error");
    assert.equal(res.body.code, "INTERNAL_ERROR");
  } finally {
    stub.restore();
  }
});

test("a dropped database connection becomes a retriable 503", async () => {
  // The other half of errorHandler's classification, reached through the real
  // stack this time: the client retries a 503 and does not retry a 500, so the
  // distinction has to survive the whole chain, not just the unit test.
  const { token, row } = asUser({ role: "student" });
  let call = 0;
  const stub = stubPoolQuery(pool, () => {
    if (call++ === 0) return { rows: [row] };
    throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
  });

  try {
    const res = await request(app).get("/api/notes").set("Cookie", `token=${token}`);
    assert.equal(res.status, 503);
    assert.equal(res.body.code, "DB_UNAVAILABLE");
  } finally {
    stub.restore();
  }
});

test("/health is open and does not describe the database it checked", async () => {
  const stub = stubPoolQuery(pool, () => ({ rows: [{ "?column?": 1 }] }));
  try {
    const res = await request(app).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { ok: true });
  } finally {
    stub.restore();
  }
});

test("/health reports 503 without leaking the driver's message", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("password authentication failed for user \"postgres\"");
  });
  try {
    const res = await request(app).get("/health");
    assert.equal(res.status, 503);
    assert.deepEqual(res.body, { ok: false });
  } finally {
    stub.restore();
  }
});
