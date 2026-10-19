import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolConnect } from "./setup.js";
import {
  proposeTag,
  approveTagProposal,
  rejectTagProposal,
  withdrawProposal,
  setMediaTags,
} from "../services/servicesTags.js";

// A new tag enters the vocabulary only through an admin (migration 029).
//
// What these pin is the line between the two roles: a lecturer's request is
// STORED and changes no tag, an admin's request or approval creates the tag and
// tags the items. The one that matters most is the negative — a lecturer's
// proposal must never insert into `tags` — because nothing on the screen would
// show that it had.

// Answers each query by the first matching rule; anything unmatched gets no rows.
const withClient = async (rules, run) => {
  const stub = stubPoolConnect(pool, (text, params) => {
    for (const [match, answer] of rules) {
      if (text.includes(match)) return typeof answer === "function" ? answer(text, params) : answer;
    }
    return { rows: [] };
  });
  try {
    const result = await run();
    return { result, calls: stub.calls };
  } finally {
    stub.restore();
  }
};

const inserted = (calls, table) => calls.filter((c) => c.text.includes(`INSERT INTO ${table}`));
const committed = (calls) => calls.some((c) => c.text === "COMMIT");

const lecturer = { id: 5, role: "lecturer" };
const admin = { id: 1, role: "admin" };

test("a lecturer's proposal is stored, linked to the item, and creates no tag", async () => {
  const { result, calls } = await withClient(
    [
      ["SELECT id FROM tags WHERE id=$1", { rows: [{ id: 40 }] }], // the parent exists
      ["AS count", { rows: [{ count: "2" }] }],
      ["INSERT INTO tag_proposals", { rows: [{ id: 9, name: "שבת הגדול", parent_id: 40, status: "pending" }] }],
    ],
    () => proposeTag({ mediaId: 12, name: "  שבת  הגדול ", parentId: 40, user: lecturer })
  );

  assert.equal(result.status, "pending");
  assert.equal(inserted(calls, "tags ").length, 0, "a lecturer's proposal created a tag");
  assert.equal(inserted(calls, "media_tags").length, 0, "a lecturer's proposal tagged the item");
  const proposal = inserted(calls, "tag_proposals")[0];
  assert.deepEqual(proposal.params, ["שבת הגדול", 40, 5], "the name was not cleaned, or the place was lost");
  assert.deepEqual(inserted(calls, "tag_proposal_media")[0].params, [9, 12]);
  assert.ok(committed(calls));
});

test("an admin's proposal creates the tag under the chosen parent and tags the item at once", async () => {
  const { result, calls } = await withClient(
    [
      ["SELECT id FROM tags WHERE id=$1", { rows: [{ id: 40 }] }],
      ["INSERT INTO tags ", { rows: [{ id: 300 }] }],
    ],
    () => proposeTag({ mediaId: 12, name: "שבת הגדול", parentId: 40, user: admin })
  );

  assert.equal(result.status, "approved");
  assert.equal(result.tag_id, 300);
  assert.deepEqual(inserted(calls, "tags ")[0].params, ["שבת הגדול", 40]);
  assert.deepEqual(inserted(calls, "media_tags")[0].params, [300, [12]]);
});

test("proposing a tag that already exists in that place is a 409, not a second proposal", async () => {
  await assert.rejects(
    withClient(
      [
        ["SELECT id FROM tags WHERE id=$1", { rows: [{ id: 40 }] }],
        ["IS NOT DISTINCT FROM", { rows: [{ id: 77 }] }],
      ],
      () => proposeTag({ mediaId: 12, name: "שבת הגדול", parentId: 40, user: lecturer })
    ),
    (err) => err.statusCode === 409
  );
});

test("a parent that does not exist is a 400 rather than a foreign-key 500", async () => {
  await assert.rejects(
    withClient([], () => proposeTag({ mediaId: 12, name: "חדש", parentId: 999, user: lecturer })),
    (err) => err.statusCode === 400
  );
});

test("an empty name is refused before anything is written", async () => {
  await assert.rejects(
    withClient([], () => proposeTag({ mediaId: 12, name: "   ", parentId: null, user: lecturer })),
    (err) => err.statusCode === 400
  );
});

// Pending proposals count towards the cap, or an item at eight tags could collect
// proposals and pass the cap on the day they are approved.
test("the per-item cap counts proposals that are still waiting", async () => {
  await assert.rejects(
    withClient(
      [["AS count", { rows: [{ count: "8" }] }]],
      () => proposeTag({ mediaId: 12, name: "חדש", parentId: null, user: lecturer })
    ),
    (err) => err.statusCode === 400
  );
});

test("approving creates the tag and tags EVERY item that waited on the proposal", async () => {
  const { result, calls } = await withClient(
    [
      ["FOR UPDATE", { rows: [{ id: 9, name: "שבת הגדול", parent_id: 40, status: "pending" }] }],
      ["INSERT INTO tags ", { rows: [{ id: 300 }] }],
      ["SELECT media_id FROM tag_proposal_media", { rows: [{ media_id: 12 }, { media_id: 13 }] }],
    ],
    () => approveTagProposal(9, 1)
  );

  assert.equal(result.tagged_count, 2);
  assert.deepEqual(inserted(calls, "tags ")[0].params, ["שבת הגדול", 40]);
  assert.deepEqual(inserted(calls, "media_tags")[0].params, [300, [12, 13]]);
  const update = calls.find((c) => c.text.includes("SET status='approved'"));
  assert.deepEqual(update.params, [9, "שבת הגדול", 40, 300, 1]);
});

test("the admin may correct the name and move it to the root before approving", async () => {
  const { calls } = await withClient(
    [
      ["FOR UPDATE", { rows: [{ id: 9, name: "שבת גדול", parent_id: 40, status: "pending" }] }],
      ["INSERT INTO tags ", { rows: [{ id: 301 }] }],
    ],
    () => approveTagProposal(9, 1, { name: "שבת הגדול", parentId: null })
  );
  assert.deepEqual(inserted(calls, "tags ")[0].params, ["שבת הגדול", null]);
});

// A tag that meanwhile came to exist at that place is reused, never duplicated.
test("approving reuses a tag that already stands in that place", async () => {
  const { calls } = await withClient(
    [
      ["FOR UPDATE", { rows: [{ id: 9, name: "שבת הגדול", parent_id: 40, status: "pending" }] }],
      ["IS NOT DISTINCT FROM", { rows: [{ id: 77 }] }],
      ["SELECT media_id FROM tag_proposal_media", { rows: [{ media_id: 12 }] }],
    ],
    () => approveTagProposal(9, 1)
  );
  assert.equal(inserted(calls, "tags ").length, 0);
  assert.deepEqual(inserted(calls, "media_tags")[0].params, [77, [12]]);
});

test("a proposal already decided cannot be decided again", async () => {
  const decided = [["FOR UPDATE", { rows: [{ id: 9, name: "x", parent_id: null, status: "approved" }] }]];
  await assert.rejects(withClient(decided, () => approveTagProposal(9, 1)), (err) => err.statusCode === 409);
  await assert.rejects(withClient(decided, () => rejectTagProposal(9, 1, "")), (err) => err.statusCode === 409);
});

test("rejecting touches no tag and no item", async () => {
  const { calls } = await withClient(
    [["FOR UPDATE", { rows: [{ id: 9, name: "x", parent_id: null, status: "pending" }] }]],
    () => rejectTagProposal(9, 1, "  כבר קיים בשם אחר  ")
  );
  assert.equal(inserted(calls, "tags ").length, 0);
  assert.equal(inserted(calls, "media_tags").length, 0);
  const update = calls.find((c) => c.text.includes("SET status='rejected'"));
  assert.deepEqual(update.params, [9, "כבר קיים בשם אחר", 1]);
});

test("withdrawing a proposal this item never made is a 404", async () => {
  await assert.rejects(
    withClient([["DELETE FROM tag_proposal_media", { rows: [], rowCount: 0 }]], () => withdrawProposal(12, 9)),
    (err) => err.statusCode === 404
  );
});

// ── The old back door ───────────────────────────────────────────────────────
//
// Anything typed used to become a root tag on save. Left open, it would make the
// whole approval flow optional.

test("a lecturer's typed name that is not a tag yet is refused, not created", async () => {
  await assert.rejects(
    withClient([], () => setMediaTags(12, { names: ["תגית חדשה"] })),
    (err) => err.statusCode === 400
  );
});

test("a lecturer may still pick a root tag that already exists by its name", async () => {
  const { calls } = await withClient(
    [["WHERE parent_id IS NULL AND LOWER(name) = ANY", { rows: [{ id: 50, key: "ישן" }] }]],
    () => setMediaTags(12, { names: ["ישן"] })
  );
  assert.equal(inserted(calls, "tags ").length, 0);
  assert.deepEqual(inserted(calls, "media_tags")[0].params, [12, 50]);
});

test("an admin's typed name still creates a root tag", async () => {
  const { calls } = await withClient(
    [["INSERT INTO tags ", { rows: [{ id: 60 }] }]],
    () => setMediaTags(12, { names: ["חדש"] }, { canCreate: true })
  );
  assert.equal(inserted(calls, "tags ").length, 1);
});
