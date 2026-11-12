import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import jwt from "jsonwebtoken";
import { createApp } from "../app.js";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  encodeMediaCursor, mediaCursorFilter, mediaPageSizeFilter, MEDIA_PAGE_SIZE, MAX_MEDIA_PAGE_SIZE,
} from "../lib/validate.js";
import { transcriptionQueue } from "../queue/transcriptionQueue.js";
import { llmQueue } from "../queue/llmQueue.js";

// The archive in pages (PRD ARCH-1): 24 at a time, an opaque cursor to the next
// page, and the total counted once, on the first.

after(async () => {
  await Promise.all([transcriptionQueue.close(), llmQueue.close()]);
});

const app = createApp();
const ROW = { id: 7, email: "u@example.com", role: "lecturer" };
const cookie = `token=${jwt.sign(ROW, process.env.JWT_SECRET, { expiresIn: "1h" })}`;

const PAGE = /FROM media_items m\s[\s\S]*LIMIT \$\d+ OFFSET \$\d+/;
const COUNT = /SELECT COUNT\(\*\)::int AS count FROM media_items m/;

// A media row as the page query returns it.
const media = (id) => ({ id, title: `שיעור ${id}`, media_type: "audio", s3_key: `local/${id}.mp3` });

const listing = async (query, rowsForPage, total = 0) => {
  const stub = stubPoolQuery(pool, (text, params) => {
    if (/FROM users/.test(text) && !/media_items/.test(text)) return { rows: [ROW] };
    if (COUNT.test(text)) return { rows: [{ count: total }] };
    if (PAGE.test(text)) return { rows: rowsForPage(params) };
    return { rows: [] };
  });
  try {
    const res = await request(app).get(`/api/media/get-all${query}`).set("Cookie", cookie);
    return { res, calls: stub.calls };
  } finally {
    stub.restore();
  }
};

// ── The guards ──────────────────────────────────────────────────────────────

test("a cursor round-trips, and no cursor is the first page", () => {
  assert.equal(mediaCursorFilter(encodeMediaCursor(48)), 48);
  assert.equal(mediaCursorFilter(undefined), 0);
  assert.equal(mediaCursorFilter(""), 0);
});

test("a cursor that was not handed out is a 400, not a wrong page", () => {
  for (const bad of ["nonsense", "eyJ2Ijo5LCJvIjoxfQ", encodeMediaCursor(-1), Buffer.from('{"v":1,"o":1.5}').toString("base64url"), "x".repeat(300)]) {
    assert.throws(() => mediaCursorFilter(bad), (err) => err.statusCode === 400, `accepted ${bad}`);
  }
});

test("the page size defaults to 24 and cannot be raised past the cap", () => {
  assert.equal(MEDIA_PAGE_SIZE, 24);
  assert.equal(mediaPageSizeFilter(undefined), 24);
  assert.equal(mediaPageSizeFilter("10"), 10);
  for (const bad of ["0", "-1", "2.5", String(MAX_MEDIA_PAGE_SIZE + 1), "all"]) {
    assert.throws(() => mediaPageSizeFilter(bad), (err) => err.statusCode === 400, `accepted ${bad}`);
  }
});

// ── The endpoint ────────────────────────────────────────────────────────────

test("the first page: 24 items, a cursor to the next, and the total", async () => {
  // The query asks for one more than the page, to learn whether there is more.
  const { res, calls } = await listing("", (params) => {
    assert.equal(params.at(-2), 25, "LIMIT is the page size plus one");
    assert.equal(params.at(-1), 0, "OFFSET 0 on the first page");
    return Array.from({ length: 25 }, (_, i) => media(i + 1));
  }, 130);
  assert.equal(res.status, 200);
  assert.equal(res.body.items.length, 24, "the extra row is not returned");
  assert.equal(res.body.total, 130);
  assert.equal(mediaCursorFilter(res.body.nextCursor), 24);
  assert.equal(res.body.items[0].s3_key, undefined, "still through publicMedia");
  assert.ok(calls.some((c) => COUNT.test(c.text)), "counted on the first page");
});

test("a later page starts where the cursor says, and is not counted again", async () => {
  const { res, calls } = await listing(`?cursor=${encodeMediaCursor(24)}`, (params) => {
    assert.equal(params.at(-1), 24);
    return Array.from({ length: 25 }, (_, i) => media(i + 25));
  });
  assert.equal(res.status, 200);
  assert.equal(mediaCursorFilter(res.body.nextCursor), 48);
  assert.equal("total" in res.body, false);
  assert.equal(calls.some((c) => COUNT.test(c.text)), false, "the count is the client's to keep");
});

test("the last page says there is no next one", async () => {
  const { res } = await listing(`?cursor=${encodeMediaCursor(120)}`, () => Array.from({ length: 10 }, (_, i) => media(i + 121)));
  assert.equal(res.body.items.length, 10);
  assert.equal(res.body.nextCursor, null);
});

// The count and the pages must describe the same set — that is why they come
// from one builder. A count over a different WHERE would say "130 results" over
// a list that ends at 90.
test("the count is filtered exactly as the page is", async () => {
  const { calls } = await listing("?type=audio&search=%D7%A9&tagIds=3&excludeTagIds=4&minDuration=60", () => [], 0);
  const page = calls.find((c) => PAGE.test(c.text));
  const count = calls.find((c) => COUNT.test(c.text));
  // From the builder's own WHERE — the one that opens on the visibility rule —
  // not the first WHERE in the text: the page's column list has subqueries.
  const whereOf = (text) => {
    const start = text.search(/WHERE \(\s*\(\s*m\.is_published/);
    const end = text.indexOf("ORDER BY", start);
    return text.slice(start, end === -1 ? undefined : end);
  };
  assert.equal(whereOf(count.text).trim(), whereOf(page.text).trim());
  assert.deepEqual(count.params, page.params.slice(0, -2), "same parameters, minus LIMIT and OFFSET");
});

test("a bad cursor or size is refused before the database is asked", async () => {
  for (const query of ["?cursor=nonsense", "?limit=1000"]) {
    const { res, calls } = await listing(query, () => {
      throw new Error("reached the page query");
    });
    assert.equal(res.status, 400, query);
    assert.equal(calls.some((c) => /media_items/.test(c.text)), false, query);
  }
});
