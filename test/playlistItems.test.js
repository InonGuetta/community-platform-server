import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// A saved list arriving WITH its lectures.
//
// The saved-content page shows each list as a heading with its own lectures
// underneath, and until now it could not: this endpoint returned a title and a
// count, so the page drew a card per list and nothing else. The alternative to
// changing it was one request PER LIST from the page — a request count that
// grows with how tidy the user is.
//
// Two things are worth asserting and neither is visible from the screen: that it
// is ONE query rather than one per list, and that a lecture the viewer may not
// see does not arrive merely because it sits in a list of theirs.

after(async () => {
  await Promise.allSettled([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();

const USER = { id: 3, email: "u@example.com", role: "student", is_active: true };
const token = jwt.sign({ id: 3, email: USER.email, role: "student" }, process.env.JWT_SECRET, {
  expiresIn: "1h",
});

const capture = () => {
  const calls = [];
  stubPoolQuery(pool, (text, params) => {
    calls.push({ text, params });
    if (/FROM users/i.test(text)) return { rows: [USER] };
    if (/FROM playlists p/i.test(text)) {
      return { rows: [{ id: 1, title: "שיעורי מוסר", item_count: 2, items: [] }] };
    }
    return { rows: [] };
  });
  return calls;
};

const get = (query = "") =>
  request(app).get(`/api/saves/playlists${query}`).set("Cookie", `token=${token}`);

const listQuery = (calls) => calls.find((c) => /FROM playlists p/i.test(c.text));

test("the lists come back with their lectures when the page asks for them", async () => {
  const calls = capture();
  const res = await get("?withItems=1");

  assert.equal(res.status, 200);
  const { text } = listQuery(calls);
  assert.match(text, /json_agg/, "the items are not being aggregated into the row");
  assert.match(text, /playlist_items/);
});

// One query, not one per list. A LATERAL join runs the inner select once per row
// of the outer one — the planner does the looping, over rows it already has.
test("in one query rather than one per list", async () => {
  const calls = capture();
  await get("?withItems=1");

  assert.match(listQuery(calls).text, /LEFT JOIN LATERAL/i);
  assert.equal(calls.filter((c) => /FROM playlist_items pi/i.test(c.text)).length, 1);
});

// The save menu calls the same endpoint, over a lecture, to draw checkboxes. The
// contents of every list would be a slower menu for nothing.
test("and not when the save menu asks, which only needs the names", async () => {
  const calls = capture();
  const res = await get("?mediaId=7");

  assert.equal(res.status, 200);
  const { text } = listQuery(calls);
  assert.doesNotMatch(text, /json_agg/);
  assert.doesNotMatch(text, /LEFT JOIN LATERAL/i);
});

test("nor when nothing is asked for at all", async () => {
  const calls = capture();
  await get();
  assert.doesNotMatch(listQuery(calls).text, /json_agg/);
});

// The same rule as the flat saved list and the single-list page, from the same
// helper. A draft or a course lecture is either visible to this user everywhere
// or nowhere — filing it in a list is not a way around that.
test("a lecture the viewer may not see does not arrive inside a list", async () => {
  const calls = capture();
  await get("?withItems=1");

  const { text, params } = listQuery(calls);
  assert.match(text, /is_published/, "the visibility rule is missing from the join");
  assert.match(text, /course_id/);
  // The scope is passed as parameters rather than interpolated.
  assert.equal(params.length, 4);
});

// A heading that says "5 שיעורים" above two cards is a page arguing with itself:
// the lectures underneath it are filtered, and three of the five belong to a
// course this viewer is not enrolled in. The single-list page already counted
// only what it could show, so the two disagreed as well.
test("the count is what the viewer can see, not what the list holds", async () => {
  const calls = capture();
  await get("?withItems=1");

  const count = listQuery(calls).text.match(/COUNT\(\*\)::int[\s\S]*?AS item_count/)[0];
  assert.match(count, /JOIN media_items/, "the count is not filtered by visibility");
  assert.match(count, /is_published/);
});

// Including for the save menu, which asks the same endpoint without items. A
// number that means one thing to the menu and another to the page is the kind of
// difference nobody finds until it is wrong on a screen.
test("and it means the same thing to the save menu", async () => {
  const calls = capture();
  await get("?mediaId=7");

  const count = listQuery(calls).text.match(/COUNT\(\*\)::int[\s\S]*?AS item_count/)[0];
  assert.match(count, /JOIN media_items/);
});

// The lecture being asked about is the one open in front of the user, so there
// is nothing to filter — and filtering it would cost a join for no answer.
test("but 'does this list already hold it' is not filtered", async () => {
  const calls = capture();
  await get("?mediaId=7");

  const contains = listQuery(calls).text.match(/EXISTS \([\s\S]*?\) AS contains/)[0];
  assert.doesNotMatch(contains, /JOIN media_items/);
});

// Without a cap this page downloads every lecture of every list in order to show
// the three most recent of each.
test("a very long list is capped rather than sent whole", async () => {
  const calls = capture();
  await get("?withItems=1");

  assert.match(listQuery(calls).text, /LIMIT \d+/);
});

test("the rows are newest first, both the lists and what is in them", async () => {
  const calls = capture();
  await get("?withItems=1");

  const { text } = listQuery(calls);
  assert.match(text, /ORDER BY recent\.added_at DESC/);
  assert.match(text, /ORDER BY p\.created_at DESC/);
});

// An empty list is a list, not a missing one: json_agg over no rows is NULL, and
// a page that does `items.map` on null crashes.
test("a list with nothing in it carries an empty array, not null", async () => {
  const calls = capture();
  await get("?withItems=1");

  assert.match(listQuery(calls).text, /COALESCE\(visible\.rows, '\[\]'::json\)/);
});
