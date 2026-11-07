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

// PERM-3 — the permissions matrix (PRD §5.2) as a mechanism, not a document.
//
// routes.test.js answers "does every route demand a session?". It never asked
// WHICH role a route admits, so a requireRole dropped from a write, or an
// "admin" widened to "lecturer", or a new admin screen mounted under a router
// that checks nothing, all passed it — the caller is signed in, and that was
// all it checked.
//
// This file writes the answer down per route and holds the code to it, three
// ways:
//
//   1. Every mounted route has a row here, and every row is a mounted route. A
//      new route fails the suite until somebody decides who may call it — the
//      one decision that is easiest to forget, because the route works without
//      it.
//   2. The roles each route DECLARES, read from the requireRole middleware in its
//      stack (router-level and route-level both), equal the row.
//   3. Every role BELOW the row is actually refused with a 403 by the running
//      app, before anything but the session lookup touches the database.
//
// What it does not cover is the second layer of §5.1, ownership ("is this
// specific item yours?"), which lives in controllers and has its own tests —
// permissions.test.js, enrolmentGate.test.js and the per-resource suites.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

// ── The matrix ──────────────────────────────────────────────────────────────
//
// The least role that may call each route. A role admits everything above it:
// lecturer means lecturer and admin, which is what requireRole("lecturer",
// "admin") says everywhere it appears.
const PUBLIC = "public"; // no session — routes.test.js says why each one is
const ANY = "signed-in"; // any role; the controller may narrow it further
const LECTURER = "lecturer";
const ADMIN = "admin";

const MATRIX = {
  // ── Auth ── the way in, and one's own account
  "post /api/auth/register": PUBLIC,
  "post /api/auth/login": PUBLIC,
  "post /api/auth/logout": PUBLIC,
  "post /api/auth/forgot-password": PUBLIC,
  "post /api/auth/reset-password": PUBLIC,
  "post /api/auth/verify-email": PUBLIC,
  "get /api/auth/google": PUBLIC,
  "get /api/auth/google/callback": PUBLIC,
  "get /api/auth/me": ANY,
  "patch /api/auth/me": ANY,
  "post /api/auth/change-password": ANY,
  // Asking is open to everyone; granting is under /api/users, admin-only.
  "post /api/auth/request-role": ANY,

  // ── Users ── "משתמשים, אישורי תפקיד" — admin only
  "get /api/users/get-all-users": ADMIN,
  "get /api/users/pending": ADMIN,
  "post /api/users/:id/approve": ADMIN,
  "post /api/users/:id/reject": ADMIN,
  "get /api/users/:id": ADMIN,
  "post /api/users/create-user": ADMIN,
  "put /api/users/update-user/:id": ADMIN,
  "delete /api/users/delete-user/:id": ADMIN,

  // ── Media ── reading follows lib/permissions.js; writing is a lecturer's,
  // and only on what they uploaded (canManageMedia, in the controller)
  "get /api/media/get-all": ANY,
  "get /api/media/tags": ANY,
  "get /api/media/creators": ANY,
  "get /api/media/continue-watching": ANY,
  "get /api/media/:id": ANY,
  "get /api/media/:id/stream": ANY,
  // A lecturer's page (PRD ATTR-10): counted over what the caller may see.
  "get /api/media/creators/:name": ANY,
  // Tags the LLM proposed (PRD ARCH-4): the lesson's manager, checked again in
  // the controller.
  "get /api/media/:id/ai-tag-suggestions": LECTURER,
  "post /api/media/:id/ai-tag-suggestions": LECTURER,
  "post /api/media/:id/ai-tag-suggestions/approve": LECTURER,
  "delete /api/media/:id/ai-tag-suggestions": LECTURER,
  "get /api/media/:id/download": ANY,
  "get /api/media/:id/download/audio": ANY,
  "get /api/media/:id/progress": ANY,
  "post /api/media/:id/progress": ANY,
  "post /api/media/upload": LECTURER,
  "put /api/media/update/:id": LECTURER,
  "delete /api/media/delete/:id": LECTURER,
  "get /api/media/:id/tag-suggestions": LECTURER,
  "get /api/media/:id/tag-proposals": LECTURER,
  "post /api/media/:id/tag-proposals": LECTURER,
  "delete /api/media/:id/tag-proposals/:proposalId": LECTURER,

  // ── Transcripts ── read by visibility; edit, run, fix, headings: lecturer
  "get /api/transcripts/search": ANY,
  "get /api/transcripts/:mediaId": ANY,
  "put /api/transcripts/:mediaId": LECTURER,
  "post /api/transcripts/:mediaId/trigger": LECTURER,
  "post /api/transcripts/:mediaId/fix-hebrew": LECTURER,
  "post /api/transcripts/:mediaId/key-point-headings": LECTURER,

  // ── Courses ── create, edit, roster: lecturer, on courses they teach
  // (assertCanManageCourse). Handing a course to another lecturer is the
  // admin-only part of PUT, decided in the controller.
  "get /api/courses/": ANY,
  "get /api/courses/:id": ANY,
  "get /api/courses/my": ANY,
  // Open to any role at the router; the controller admits only the student
  // themself or an admin.
  "get /api/courses/students/:studentId/enrollments": ANY,
  "get /api/courses/my-students": LECTURER,
  "post /api/courses/": LECTURER,
  "put /api/courses/:id": LECTURER,
  "delete /api/courses/:id": LECTURER,
  "get /api/courses/:id/students": LECTURER,
  "post /api/courses/:id/students": LECTURER,
  "get /api/courses/:id/enrollable-students": LECTURER,
  "delete /api/courses/:id/students/:studentId": LECTURER,
  // Joining by code (PRD ROST-9): anybody signed in may ask, and withdraw their
  // own request; the code and the queue are the course's lecturer's.
  "post /api/courses/join": ANY,
  // The course as a track (PRD CRS-1..3): following it is checked in the
  // controller (enrolled, or a lecturer/admin); arranging it is the lecturer's.
  "get /api/courses/:id/lessons": ANY,
  "put /api/courses/:id/lessons/order": LECTURER,
  "get /api/courses/:id/report": LECTURER,
  "get /api/courses/join-requests/mine": ANY,
  "delete /api/courses/join-requests/:requestId": ANY,
  "post /api/courses/:id/join-code": LECTURER,
  "delete /api/courses/:id/join-code": LECTURER,
  "get /api/courses/:id/join-requests": LECTURER,
  "post /api/courses/:id/join-requests/:requestId/approve": LECTURER,
  "post /api/courses/:id/join-requests/:requestId/reject": LECTURER,

  // ── Live sessions ── join: anyone; create and start: lecturer; end: the host
  "get /api/sessions/active": ANY,
  "get /api/sessions/upcoming": ANY,
  "get /api/sessions/:id": ANY,
  "post /api/sessions/:id/join": ANY,
  "get /api/sessions/:id/calendar.ics": ANY,
  "post /api/sessions/create": LECTURER,
  "post /api/sessions/:id/start": LECTURER,
  "delete /api/sessions/:id/end": LECTURER,
  "post /api/sessions/:id/recordings": LECTURER,
  "put /api/sessions/:id/recordings/:recordingId/parts/:part": LECTURER,
  "post /api/sessions/:id/recordings/:recordingId/finish": LECTURER,

  // ── Personal ── private to the caller, whatever their role
  "get /api/discussion/archive/conversation": ANY,
  "post /api/discussion/archive/conversation": ANY,
  "post /api/discussion/archive/messages/stream": ANY,
  "get /api/discussion/:mediaId/search": ANY,
  "get /api/discussion/:mediaId/conversation": ANY,
  "post /api/discussion/:mediaId/conversation": ANY,
  "get /api/discussion/:mediaId/conversations": ANY,
  "get /api/discussion/:mediaId/conversations/:conversationId": ANY,
  "delete /api/discussion/:mediaId/conversations/:conversationId": ANY,
  "post /api/discussion/:mediaId/conversations/:conversationId/resume": ANY,
  "post /api/discussion/:mediaId/messages": ANY,
  "post /api/discussion/:mediaId/messages/stream": ANY,
  "get /api/bookmarks/": ANY,
  "post /api/bookmarks/": ANY,
  "put /api/bookmarks/:id": ANY,
  "delete /api/bookmarks/:id": ANY,
  "get /api/notes/": ANY,
  "post /api/notes/": ANY,
  "put /api/notes/order": ANY,
  "put /api/notes/:id": ANY,
  "delete /api/notes/:id": ANY,
  "get /api/likes/": ANY,
  "post /api/likes/": ANY,
  "delete /api/likes/:mediaId": ANY,
  "get /api/saves/": ANY,
  "post /api/saves/": ANY,
  "delete /api/saves/:mediaId": ANY,
  "get /api/saves/playlists": ANY,
  "get /api/saves/playlists/:id": ANY,
  "post /api/saves/playlists": ANY,
  "patch /api/saves/playlists/:id": ANY,
  "delete /api/saves/playlists/:id": ANY,
  "post /api/saves/playlists/:id/items": ANY,
  "delete /api/saves/playlists/:id/items/:mediaId": ANY,

  // ── Donations ──
  "post /api/donations/webhook": PUBLIC, // Stripe, authenticated by signature
  // The donor's own donation checked against Stripe; ownership in the controller.
  "post /api/donations/:id/sync": ANY,
  // A lesson its manager made public (PRD COM-3b): the row decides, not the caller.
  "get /api/public/media/:id": PUBLIC,
  "get /api/public/media/:id/stream": PUBLIC,
  "get /api/public/share/:id": PUBLIC,
  "post /api/donations/create-intent": ANY,
  "get /api/donations/my-history": ANY,

  // ── Notifications ── everybody's own inbox (PRD 6.15)
  "get /api/notifications/": ANY,
  "post /api/notifications/read-all": ANY,
  "post /api/notifications/:id/read": ANY,
  "get /api/notifications/preferences": ANY,
  "put /api/notifications/preferences": ANY,
  // Opened from an inbox with no session; the signed token is the credential.
  "post /api/notifications/unsubscribe": PUBLIC,

  // ── Admin ── "לוח בקרה, הצעות תגיות"
  "get /api/admin/stats": ADMIN,
  "get /api/admin/queue-status": ADMIN,
  "get /api/admin/system-health": ADMIN,
  "get /api/admin/pipeline-trouble": ADMIN,
  "post /api/admin/reconcile": ADMIN,
  "get /api/admin/donations": ADMIN,
  "get /api/admin/ai-usage": ADMIN,
  "get /api/admin/tag-proposals": ADMIN,
  "post /api/admin/tag-proposals/:id/approve": ADMIN,
  "post /api/admin/tag-proposals/:id/reject": ADMIN,
};

// What each level means as requireRole would spell it. null: no role check.
const DECLARED_FOR = {
  [PUBLIC]: null,
  [ANY]: null,
  [LECTURER]: ["admin", "lecturer"],
  [ADMIN]: ["admin"],
};

// The roles a level refuses — what the runtime sweep sends.
const REFUSED_FOR = {
  [PUBLIC]: [],
  [ANY]: [],
  [LECTURER]: ["student"],
  [ADMIN]: ["student", "lecturer"],
};

// ── Reading the roles off the running app ───────────────────────────────────
//
// Express keeps a router's middleware and its routes in one ordered stack, and
// a router.use() applies only to the routes registered AFTER it. So the stack is
// walked in order, and a route's effective roles are every role check above it
// in its router intersected with every one in its own chain — two checks in a
// row admit only the roles both admit.
const intersect = (a, b) => (a === null ? b : b === null ? a : a.filter((role) => b.includes(role)));

const declaredRoutes = () => {
  const routes = [];
  for (const [prefix, router] of API_ROUTERS) {
    let routerRoles = null;
    for (const layer of router.stack ?? []) {
      if (!layer.route) {
        if (layer.handle?.allowedRoles) routerRoles = intersect(routerRoles, [...layer.handle.allowedRoles]);
        continue;
      }
      let roles = routerRoles;
      for (const step of layer.route.stack ?? []) {
        if (step.handle?.allowedRoles) roles = intersect(roles, [...step.handle.allowedRoles]);
      }
      for (const method of Object.keys(layer.route.methods ?? {})) {
        routes.push({
          key: `${method} ${prefix}${layer.route.path}`,
          method,
          path: prefix + layer.route.path,
          roles: roles === null ? null : [...roles].sort(),
        });
      }
    }
  }
  return routes;
};

const concrete = (path) => path.replace(/:[A-Za-z]+/g, "1");

// ── 1. The matrix and the app list the same routes ──────────────────────────

test("the walk finds the API, and finds role checks in it", () => {
  // Guards the two sweeps below against checking nothing: if Express changed
  // the shape of its stack, or requireRole lost its label, every comparison
  // would read "no roles" and the ANY rows would all pass.
  const routes = declaredRoutes();
  assert.ok(routes.length > 40, `expected the full API, found ${routes.length} routes`);
  assert.ok(routes.some((r) => r.roles?.length === 1), "no admin-only route was recognised");
  assert.ok(routes.some((r) => r.roles?.length === 2), "no lecturer route was recognised");
});

test("every mounted route has a row in the matrix", () => {
  const missing = declaredRoutes().map((r) => r.key).filter((k) => !(k in MATRIX));
  assert.deepEqual(
    missing, [],
    "a new route needs a decision about who may call it — add it to MATRIX, with the least role allowed"
  );
});

test("every row in the matrix is a mounted route", () => {
  // A stale row is how the matrix stops describing the app: a renamed route
  // leaves its old row passing forever while the new path goes unchecked.
  const mounted = new Set(declaredRoutes().map((r) => r.key));
  const stale = Object.keys(MATRIX).filter((k) => !mounted.has(k));
  assert.deepEqual(stale, [], "these rows name routes the app no longer has");
});

// ── 2. What each route declares ─────────────────────────────────────────────

test("each route declares exactly the roles its row allows", async (t) => {
  for (const route of declaredRoutes()) {
    const level = MATRIX[route.key];
    if (level === undefined) continue; // reported by the inventory test above
    await t.test(route.key, () => {
      assert.deepEqual(
        route.roles, DECLARED_FOR[level],
        `the matrix says "${level}", the route's requireRole admits ${JSON.stringify(route.roles)}`
      );
    });
  }
});

// ── 3. What the running app refuses ─────────────────────────────────────────

const sessionFor = (role) => {
  const row = { id: 7, email: "u@example.com", role };
  const token = jwt.sign(row, process.env.JWT_SECRET, { expiresIn: "1h" });
  return { row, cookie: `token=${token}` };
};

test("every role below a route's row is refused with a 403", async (t) => {
  for (const role of ["student", "lecturer"]) {
    const { row, cookie } = sessionFor(role);
    // verifyToken re-reads the user, so that lookup answers. Anything else is a
    // route that reached the database before deciding the caller may be there.
    const stub = stubPoolQuery(pool, (text) => {
      if (/FROM users/i.test(text)) return { rows: [row] };
      throw new Error(`reached the database before the role check: ${text.slice(0, 60)}`);
    });
    try {
      for (const route of declaredRoutes()) {
        if (!REFUSED_FOR[MATRIX[route.key]]?.includes(role)) continue;
        const res = await request(app)[route.method](concrete(route.path)).set("Cookie", cookie);
        await t.test(`${role} → ${route.key}`, () => {
          assert.equal(res.status, 403, `answered ${res.status}; a ${role} must be refused here`);
        });
      }
    } finally {
      stub.restore();
    }
  }
});
