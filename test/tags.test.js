import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";
import { cleanTagNames, cleanTagSelection, getTagTree } from "../services/servicesTags.js";
import { tagIdFilter, MAX_TAG_FILTER_IDS } from "../lib/validate.js";
import { getAllMedia } from "../services/servicesMedia.js";

// Tags — what kind of content an item is.
//
// The normalising is where the value is. A UNIQUE index treats "שיעור כללי" and
// "שיעור  כללי" as two tags; a person treats them as one. Once both exist the
// filter lists them separately with the items split between them, which looks
// like missing content and cannot be undone without a manual merge.

// ── Normalising ─────────────────────────────────────────────────────────────

test("tags are trimmed", () => {
  assert.deepEqual(cleanTagNames(["  הלכה  "]), ["הלכה"]);
});

// The one that actually bites: internal whitespace is invisible in a text field.
test("internal whitespace collapses to a single space", () => {
  assert.deepEqual(cleanTagNames(["שיעור  כללי"]), ["שיעור כללי"]);
  assert.deepEqual(cleanTagNames(["שיעור\tכללי"]), ["שיעור כללי"]);
});

test("duplicates are removed", () => {
  assert.deepEqual(cleanTagNames(["הלכה", "הלכה"]), ["הלכה"]);
});

// Hebrew has no case, so this matters for the tags typed in English — and those
// are exactly the ones somebody will type twice differently.
test("duplicates are removed case-insensitively, keeping the first spelling", () => {
  assert.deepEqual(cleanTagNames(["Halacha", "halacha", "HALACHA"]), ["Halacha"]);
});

test("empty and whitespace-only entries are dropped, not stored", () => {
  assert.deepEqual(cleanTagNames(["הלכה", "", "   ", null, undefined]), ["הלכה"]);
});

test("a non-list is an empty list, not a crash", () => {
  for (const value of [null, undefined, "הלכה", 42, {}]) {
    assert.deepEqual(cleanTagNames(value), []);
  }
});

test("a tag longer than the column is refused with a 400", () => {
  assert.throws(() => cleanTagNames(["x".repeat(61)]), (err) => err.statusCode === 400);
});

test("more tags than an item may carry is refused", () => {
  const nine = Array.from({ length: 9 }, (_, i) => `tag${i}`);
  assert.throws(() => cleanTagNames(nine), (err) => err.statusCode === 400);
  // The cap itself is fine.
  assert.equal(cleanTagNames(nine.slice(0, 8)).length, 8);
});

// De-duplication happens BEFORE the cap, so eight tags typed with a repeat are
// eight tags, not a refusal.
test("duplicates do not count towards the cap", () => {
  const withRepeats = ["a", "a", "b", "b", "c", "c", "d", "d", "e", "e"];
  assert.deepEqual(cleanTagNames(withRepeats), ["a", "b", "c", "d", "e"]);
});

// ── Filtering by them ───────────────────────────────────────────────────────

const runList = async (filters) => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await getAllMedia(filters);
    return stub.calls[0];
  } finally {
    stub.restore();
  }
};

test("every media row carries its tags", async () => {
  const call = await runList({});
  assert.match(call.text, /ARRAY_AGG\(t\.name/, "tags ride along with the row");
  assert.match(call.text, /ARRAY\[\]::varchar\[\]/, "an untagged item arrives as [], not null");
});

// Names are for showing; ids are for editing. A form that re-saves an item's
// tags cannot match them by name — five names in this taxonomy occur in two
// branches, so the wrong one would win and the item would quietly change branch.
test("and carries their ids as well, which is what an edit form re-saves", async () => {
  const call = await runList({});
  assert.match(call.text, /ARRAY_AGG\(mt\.tag_id/, "ids ride along too");
  assert.match(call.text, /ARRAY\[\]::int\[\]/, "an untagged item arrives as [], not null");
});

// ── OR inside a heading, AND between headings ───────────────────────────────
//
// It was AND across every chosen tag, and that made the commonest request in
// the archive impossible: two parashot asked for a shiur that is on both, of
// which there are almost none, so the archive came back empty and the filter
// read as broken. The unit of AND is the HEADING a choice sits under, not the
// choice.
//
// By ID, not by name — the taxonomy repeats five names across branches, so a
// name filter would match both and the caller could not say which it meant.
test("the filter is by id, and expands each choice to its subtree", async () => {
  const call = await runList({ tagIds: [3, 9] });
  assert.match(call.text, /WITH RECURSIVE up AS/, "each choice is walked up to its heading");
  assert.match(call.text, /down AS/, "and down into its own subtree");
  assert.doesNotMatch(call.text, /t\.name = ANY/, "names are ambiguous in a tree");
});

// Counting DISTINCT headings rather than choices is the whole change: two
// parashot under the same heading are alternatives, so matching either satisfies
// it once.
test("headings are what must all be matched, not choices", async () => {
  const call = await runList({ tagIds: [3, 9] });
  assert.match(call.text, /COUNT\(DISTINCT sub\.facet_id\)/);
  assert.doesNotMatch(call.text, /COUNT\(DISTINCT sub\.chosen_id\)/, "the old AND-across-all rule");
});

// The required number is measured by the same walk that produced the matches. A
// second, differently-written copy is how "matched every heading" and "how many
// headings were named" come to disagree.
test("the number of headings to match is computed, not passed in", async () => {
  const call = await runList({ tagIds: [3, 9] });
  assert.match(call.text, /SELECT COUNT\(DISTINCT facet_id\) FROM heading/);
  // The ids are bound once and used by both halves.
  assert.ok(call.params.some((p) => Array.isArray(p) && p.includes(3) && p.includes(9)));
});

test("no tags means no tag condition at all", async () => {
  const call = await runList({ tagIds: [] });
  assert.doesNotMatch(call.text, /WITH RECURSIVE up AS/);
});

// ── Taking tags back out ────────────────────────────────────────────────────
//
// "Everything in תורה except שמות" cannot be said by choosing the four books to
// keep: choices combine with AND, so that asks for an item in בראשית and שמות at
// once and the archive comes back empty. Removal is a second list.

test("an exclusion removes the whole subtree, not just the named tag", async () => {
  const call = await runList({ excludeTagIds: [5] });
  assert.match(call.text, /NOT EXISTS/, "an excluded tag must remove the item");
  assert.match(
    call.text,
    /WITH RECURSIVE excluded_descendants/,
    "excluding שמות must exclude the parashot inside it"
  );
  assert.ok(
    call.params.some((p) => Array.isArray(p) && p.includes(5)),
    "the ids are bound, not interpolated"
  );
});

// One excluded tag on an item is enough — there is nothing to tally, which is
// why this is NOT EXISTS and the positive filter is a COUNT.
test("excluding is not counted the way choosing is", async () => {
  const call = await runList({ excludeTagIds: [3, 5] });
  assert.doesNotMatch(call.text, /COUNT\(DISTINCT sub\.chosen_id\)/);
});

// The one that makes the feature work at all: both lists in one query, each
// with its own recursive walk, neither shadowing the other's CTE name.
test("choosing and excluding compose in a single query", async () => {
  const call = await runList({ tagIds: [2], excludeTagIds: [5] });
  assert.match(call.text, /WITH RECURSIVE up AS/, "the choice still expands");
  assert.match(call.text, /WITH RECURSIVE excluded_descendants/, "and so does the exclusion");
  assert.match(call.text, /COUNT\(DISTINCT sub\.facet_id\)/);
  assert.match(call.text, /NOT EXISTS/);
});

// "Everything except X" is a legitimate request and needs no positive choice, so
// the two blocks are independent conditions rather than one nested in the other.
test("an exclusion stands on its own without a choice", async () => {
  const call = await runList({ excludeTagIds: [5] });
  assert.doesNotMatch(call.text, /WITH RECURSIVE up AS/);
  assert.match(call.text, /NOT EXISTS/);
});

test("no exclusions means no exclusion condition at all", async () => {
  const call = await runList({ tagIds: [2], excludeTagIds: [] });
  assert.doesNotMatch(call.text, /NOT EXISTS/);
});

// ── What the two lists accept ───────────────────────────────────────────────
//
// Both lists go through one guard, so they cannot come to disagree about what an
// id is — the filter that refuses "abc" in one list and drops it silently from
// the other is the kind of difference nobody finds until it matters.

test("a repeatable parameter arrives as an array or as one value", () => {
  assert.deepEqual(tagIdFilter(["3", "9"], "tagIds"), [3, 9]);
  assert.deepEqual(tagIdFilter("3", "tagIds"), [3]);
});

test("an absent list is no filter, not a refusal", () => {
  assert.deepEqual(tagIdFilter(undefined, "tagIds"), []);
  assert.deepEqual(tagIdFilter("", "tagIds"), []);
});

// Dropped silently, this answers a filter the caller never asked for: a full
// page of results that looks narrowed and is not.
test("something that is not an id is refused, not dropped", () => {
  for (const bad of ["abc", "1.5", "-3", "0", ["3", "abc"]]) {
    assert.throws(() => tagIdFilter(bad, "tagIds"), (err) => err.statusCode === 400);
  }
});

test("the same tag twice is the same question, so it is de-duplicated", () => {
  assert.deepEqual(tagIdFilter(["3", "3", "9"], "tagIds"), [3, 9]);
});

// Each id becomes a recursive walk of its subtree, so a list naming the whole
// vocabulary turns one URL into a few hundred tree walks.
test("a list longer than the cap is refused", () => {
  const overCap = Array.from({ length: MAX_TAG_FILTER_IDS + 1 }, (_, i) => String(i + 1));
  assert.throws(() => tagIdFilter(overCap, "tagIds"), (err) => err.statusCode === 400);
  assert.equal(tagIdFilter(overCap.slice(0, MAX_TAG_FILTER_IDS), "tagIds").length, MAX_TAG_FILTER_IDS);
});

// ── Filtering by date ───────────────────────────────────────────────────────
//
// Both of these replaced an earlier pair that asserted a raw timestamp
// comparison. That comparison was wrong, so the tests pinning it were pinning a
// bug — which is why they were rewritten rather than kept alongside.

// created_at is stored in UTC and Israel is two or three hours ahead, so a shiur
// uploaded at 00:30 on the 6th sits at 21:30 or 22:30 on the FIFTH. Comparing
// the raw timestamp filed it under the wrong day — and only for uploads near
// midnight, which made the symptom look random rather than systematic.
test("dates are compared as local calendar days, not UTC ones", async () => {
  const call = await runList({ uploadedAfter: "2026-01-06" });
  assert.match(call.text, /AT TIME ZONE 'Asia\/Jerusalem'/, "the zone must be applied");
  assert.match(call.text, /::date >= /, "and the comparison made on the date, not the timestamp");
});

// The "+ 1 day" the previous version needed is gone: comparing local dates makes
// the end of the range inclusive by construction.
test("the end of the range is inclusive without date arithmetic", async () => {
  const call = await runList({ uploadedBefore: "2026-01-31" });
  assert.match(call.text, /::date <= /);
  assert.doesNotMatch(call.text, /INTERVAL '1 day'/);
});

// Typing a tag name into the search box used to return nothing while the filter
// beside it found ten items — two controls answering the same question
// differently, with nothing on screen to explain why.
test("search covers the title, the attribution AND the tags", async () => {
  const call = await runList({ search: "וירא" });
  assert.match(call.text, /m\.title ILIKE/);
  assert.match(call.text, /m\.creator_name ILIKE/);
  assert.match(call.text, /t\.name ILIKE/, "a tag name must be searchable");
  // One bound parameter for all three, so they cannot drift apart.
  assert.equal(call.params.filter((p) => p === "%וירא%").length, 1);
});

// A search is "find me anything that mentions this", so matching both שופטים the
// parasha and שופטים the book is correct here. The FILTER is where the caller
// says which one they meant — which is why that one is by id.
test("the creator filter is exact, not a search", async () => {
  const call = await runList({ creator: "הרב כהן" });
  assert.match(call.text, /m\.creator_name = \$/);
  assert.ok(call.params.includes("הרב כהן"));
});



// ── The counts on the tree are per viewer ───────────────────────────────────
//
// The number beside a branch used to count every tagged row in the table, so a
// student saw "7", clicked, and got three — the rest were drafts or belonged to
// a course they are not enrolled in. A count that disagrees with what the filter
// returns reads as missing content, which is the one thing a filter must never
// look like.

const runTree = async (scope) => {
  const stub = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await getTagTree(scope);
    return stub.calls[0];
  } finally {
    stub.restore();
  }
};

test("the tree counts only what the viewer may see", async () => {
  const call = await runTree({ visibleCourses: [3], visibleDrafts: [7] });
  assert.match(call.text, /is_published/, "the visibility rule is applied to the count");
  assert.deepEqual(call.params[0], [3], "the courses are bound");
  assert.deepEqual(call.params[1], [7], "and so are the drafts");
});

// The same fail-closed rule the listing draws: an ABSENT scope is nobody's
// courses and nobody's drafts, never everybody's.
test("an absent scope counts nothing restricted, rather than everything", async () => {
  const call = await runTree(undefined);
  assert.deepEqual(call.params, [[], []]);
});

test("an unrestricted viewer is passed through as unrestricted", async () => {
  const call = await runTree({ visibleCourses: null, visibleDrafts: null });
  assert.deepEqual(call.params, [null, null]);
});

// ── What comes back after tags are saved ────────────────────────────────────
//
// The client replaces its copy of an item with whatever the update returns, so a
// response that predates the tag write leaves the card showing the old tags.
// That is exactly what happened: tags saved from the dialog appeared only after
// something else forced a refetch — opening the lesson and coming back — so the
// save had worked and the screen said it had not.

test("the row is read again after the tags are written, not before", async () => {
  const { updateMedia } = await import("../controllers/controllersMedia.js");
  const order = [];
  const stub = stubPoolQuery(pool, (text) => {
    if (/UPDATE media_items/.test(text)) order.push("update");
    else if (/SELECT[\s\S]*ARRAY_AGG/.test(text)) order.push("read");
    return { rows: [{ id: 5, title: "שיעור", tags: ["ויחי"], tag_ids: [15] }] };
  });
  const connectStub = stubPoolConnect(pool, (text) => {
    if (/INSERT INTO media_tags/.test(text)) order.push("write tags");
    return { rows: [] };
  });
  try {
    let body;
    await updateMedia(
      { params: { id: 5 }, body: { tagIds: [15] }, user: { id: 1, role: "admin" } },
      { status: () => ({ json: (payload) => { body = payload; } }) }
    );
    // The last thing done before answering is the read, and it happens after the
    // tags are in.
    assert.equal(order.at(-1), "read", `expected the read to be last, got ${order.join(" → ")}`);
    assert.ok(order.indexOf("write tags") < order.lastIndexOf("read"));
    assert.deepEqual(body.tags, ["ויחי"], "the answer carries the tags that were just saved");
  } finally {
    stub.restore();
    connectStub.restore();
  }
});

// Nothing to re-read when nothing changed: the publish toggle sends no tags and
// must not pay for an extra query on the busiest write in the archive.
test("an update that does not touch tags does not read the row twice", async () => {
  const { updateMedia } = await import("../controllers/controllersMedia.js");
  let reads = 0;
  const stub = stubPoolQuery(pool, (text) => {
    if (/SELECT[\s\S]*ARRAY_AGG/.test(text)) reads += 1;
    return { rows: [{ id: 5, title: "שיעור", tags: [], tag_ids: [] }] };
  });
  try {
    await updateMedia(
      { params: { id: 5 }, body: { isPublished: true }, user: { id: 1, role: "admin" } },
      { status: () => ({ json: () => {} }) }
    );
    // One for the ownership check, one for what updateMedia returns.
    assert.equal(reads, 2);
  } finally {
    stub.restore();
  }
});

// ── Uploading with tags ─────────────────────────────────────────────────────
//
// Two failures that only ever showed up together, and both cost the user
// something they cannot get back: a refusal raised after the file was stored
// destroyed the upload while leaving its row behind, and a 201 that predated the
// tag write made an item uploaded WITH tags render as untagged — after which
// opening the tag dialog on it seeded an empty picker whose save wiped them.

test("an unacceptable tag list is refused before anything is written", async () => {
  const nine = Array.from({ length: 9 }, (_, i) => `tag${i}`);
  // The same guard the upload path calls, and the point is WHERE it runs: it
  // needs no database, so it can answer before the row exists.
  assert.throws(() => cleanTagSelection({ names: nine }), (err) => err.statusCode === 400);
  assert.throws(
    () => cleanTagSelection({ ids: [1, 2, 3, 4, 5], names: ["a", "b", "c", "d"] }),
    (err) => err.statusCode === 400,
    "ids and names share one budget"
  );
});

test("a selection the item may carry comes back cleaned", () => {
  assert.deepEqual(cleanTagSelection({ ids: ["3", 3, "x"], names: ["  הלכה  "] }), {
    ids: [3],
    names: ["הלכה"],
  });
  assert.deepEqual(cleanTagSelection(), { ids: [], names: [] });
});

test("the row returned by an upload carries the tags it was given", async () => {
  const { createMedia } = await import("../controllers/controllersMedia.js");
  const order = [];
  const stub = stubPoolQuery(pool, (text) => {
    if (/INSERT INTO media_items/.test(text)) order.push("insert");
    else if (/SELECT[\s\S]*ARRAY_AGG/.test(text)) order.push("read");
    return { rows: [{ id: 9, title: "שיעור", tags: ["ויחי"], tag_ids: [15], s3_key: "local/x.mp3" }] };
  });
  const connectStub = stubPoolConnect(pool, (text) => {
    if (/INSERT INTO media_tags/.test(text)) order.push("write tags");
    return { rows: [{ id: 15 }] };
  });
  try {
    let body;
    let status;
    await createMedia(
      {
        user: { id: 1, role: "admin" },
        file: { filename: "x.mp3", path: "/tmp/x.mp3" },
        body: { title: "שיעור", mediaType: "audio", tagIds: [15] },
      },
      { status: (code) => { status = code; return { json: (payload) => { body = payload; } }; } }
    );
    assert.equal(status, 201);
    assert.deepEqual(body.tags, ["ויחי"], "an item uploaded with tags must not render as untagged");
    assert.equal(order.at(-1), "read", `expected the read last, got ${order.join(" → ")}`);
  } finally {
    stub.restore();
    connectStub.restore();
  }
});

// The file is already stored and may be hundreds of megabytes; an item that is
// merely untagged can be tagged from its card, while one whose file was deleted
// is gone.
test("a tagging failure after the file is stored does not destroy the upload", async () => {
  const { createMedia } = await import("../controllers/controllersMedia.js");
  const stub = stubPoolQuery(pool, () => ({
    rows: [{ id: 9, title: "שיעור", tags: [], tag_ids: [], s3_key: "local/x.mp3" }],
  }));
  const connectStub = stubPoolConnect(pool, (text) => {
    if (/DELETE FROM media_tags/.test(text)) throw new Error("connection reset");
    return { rows: [] };
  });
  try {
    let status;
    let body;
    await createMedia(
      {
        user: { id: 1, role: "admin" },
        file: { filename: "x.mp3", path: "/tmp/x.mp3" },
        body: { title: "שיעור", mediaType: "audio", tagIds: [15] },
      },
      { status: (code) => { status = code; return { json: (payload) => { body = payload; } }; } }
    );
    assert.equal(status, 201, "the upload stands even though the tagging did not");
    assert.equal(body.id, 9);
  } finally {
    stub.restore();
    connectStub.restore();
  }
});

// The order is the whole fix: the refusal has to come out BEFORE the row is
// inserted. Checked by making an insert fatal — if the guard has moved back
// after the write, this fails with the wrong error.
test("too many tags is refused before the media row is inserted", async () => {
  const { createMedia } = await import("../controllers/controllersMedia.js");
  const stub = stubPoolQuery(pool, (text) => {
    if (/INSERT INTO media_items/.test(text)) {
      throw new Error("a row was inserted for an upload that should have been refused");
    }
    return { rows: [] };
  });
  try {
    await assert.rejects(
      createMedia(
        {
          user: { id: 1, role: "admin" },
          file: { filename: "x.mp3", path: "/tmp/x.mp3" },
          body: {
            title: "שיעור",
            mediaType: "audio",
            tags: Array.from({ length: 9 }, (_, i) => `tag${i}`),
          },
        },
        { status: () => ({ json: () => {} }) }
      ),
      (err) => err.statusCode === 400
    );
  } finally {
    stub.restore();
  }
});
