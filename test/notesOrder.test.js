import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import * as controllersNotes from "../controllers/controllersNotes.js";
import * as servicesNotes from "../services/servicesNotes.js";

// The notebook is a document the user arranges by hand, so the order of the
// notes is data — not a side effect of when each one was last touched. Three
// things have to hold for that to be true, and each is a test below:
//
//   * the list comes back in the stored order, not in updated_at order;
//   * an edit does not move a note, and a reorder does not count as an edit;
//   * a reorder can only ever touch the caller's own notes.

const OWNER = { id: 7, role: "student" };

const fakeRes = () => ({
  statusCode: 0,
  body: null,
  status(c) { this.statusCode = c; return this; },
  json(b) { this.body = b; return this; },
});

const capture = (rows = []) => stubPoolQuery(pool, () => ({ rows }));

test("the notebook is listed in the order its owner put it in", async () => {
  const db = capture();
  try {
    await servicesNotes.getNotesByUser(OWNER.id);
    const sql = db.calls[0].text;
    assert.match(sql, /ORDER BY n\.sort_order ASC/);
    // The tie-break matters as much as the key: rows sharing a sort_order would
    // otherwise come back in a different order on every request.
    assert.match(sql, /n\.id DESC/);
    assert.doesNotMatch(sql, /ORDER BY[\s\S]*updated_at/);
  } finally {
    db.restore();
  }
});

// Where the user is about to start typing. Placed relative to what they already
// have rather than by renumbering the notebook, so creating a note stays one
// INSERT however many notes are in it.
test("a new note is placed at the top without renumbering the rest", async () => {
  const db = capture([{ id: 1 }]);
  try {
    await servicesNotes.createNote(OWNER.id, { title: "", body: "" });
    const sql = db.calls[0].text;
    assert.match(sql, /MIN\(sort_order\)/);
    assert.match(sql, /- 1/);
    assert.equal(db.calls.length, 1, "creating a note must not cost a second write");
  } finally {
    db.restore();
  }
});

test("a reorder writes the given order and is scoped to the caller", async () => {
  const db = capture([{ id: 5 }, { id: 9 }, { id: 2 }]);
  try {
    const res = fakeRes();
    await controllersNotes.reorderNotes({ user: OWNER, body: { ids: [5, 9, 2] } }, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body, { reordered: 3 });

    const { text, params } = db.calls[0];
    assert.match(text, /UPDATE notes SET sort_order/);
    assert.match(text, /WITH ORDINALITY/);
    // The ownership check IS the authorisation here: a note belonging to
    // somebody else matches nothing and is skipped.
    assert.match(text, /notes\.user_id = \$1/);
    assert.deepEqual(params, [OWNER.id, [5, 9, 2]]);
  } finally {
    db.restore();
  }
});

// Moving a note is not editing it. If a reorder bumped updated_at, every drag
// would rewrite the date on every card the user just rearranged.
test("a reorder does not touch updated_at", async () => {
  const db = capture();
  try {
    await servicesNotes.reorderNotes(OWNER.id, [3, 1]);
    assert.doesNotMatch(db.calls[0].text, /updated_at/);
  } finally {
    db.restore();
  }
});

// Postgres would accept a list naming the same note twice and update that row
// twice with two different positions, picking a winner by nothing in
// particular. A 400 says which half of the system is wrong.
test("a list that names the same note twice is refused", async () => {
  const db = capture();
  try {
    await assert.rejects(
      () => controllersNotes.reorderNotes({ user: OWNER, body: { ids: [4, 4] } }, fakeRes()),
      { statusCode: 400 }
    );
    assert.equal(db.calls.length, 0, "nothing may be written for a list that cannot be honoured");
  } finally {
    db.restore();
  }
});

test("a reorder without a list of ids is refused", async () => {
  const db = capture();
  try {
    for (const body of [undefined, {}, { ids: [] }, { ids: "1,2" }, { ids: [1, "x"] }, { ids: [0] }]) {
      await assert.rejects(
        () => controllersNotes.reorderNotes({ user: OWNER, body }, fakeRes()),
        { statusCode: 400 },
        `expected a 400 for ${JSON.stringify(body)}`
      );
    }
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});

// An unbounded array in a request body is a way to make the server build
// something very large from something very small.
test("an absurdly long list is refused rather than executed", async () => {
  const db = capture();
  try {
    const ids = Array.from({ length: 1001 }, (_, i) => i + 1);
    await assert.rejects(
      () => controllersNotes.reorderNotes({ user: OWNER, body: { ids } }, fakeRes()),
      { statusCode: 400 }
    );
    assert.equal(db.calls.length, 0);
  } finally {
    db.restore();
  }
});
