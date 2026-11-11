import "./setup.js";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { stubPoolQuery, stubPoolConnect } from "./setup.js";

// The hybrid statement across lessons — two rankings (keyword, vector), the
// visibility inside each, RRF fusion — is built once (transcripts/search.js →
// hybridSearchSql) and sent by two callers: the library search and the archive
// chat's retrieval. Driven here through both, for real: OpenAI is a local fake
// server (the SDK reads OPENAI_BASE_URL), so nothing leaves the machine and the
// suite stays hermetic.

const server = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    res.setHeader("content-type", "application/json");
    if (req.url.endsWith("/embeddings")) {
      res.end(JSON.stringify({ object: "list", data: [{ object: "embedding", index: 0, embedding: [0.25, -0.5] }], model: "x", usage: { prompt_tokens: 1, total_tokens: 1 } }));
    } else {
      // Not retried: the rerank fails and each caller keeps the fused order.
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { message: "fake", type: "invalid_request_error" } }));
    }
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
after(() => server.close());

// After the base URL is set: the clients are made when these modules load.
const { pool } = await import("../db/pool.js");
const { hybridSearchSql, searchTranscripts, FUSE_DEPTH } = await import("../services/transcripts/search.js");
const { searchArchive } = await import("../services/discussion/archive.js");

const flat = (sql) => sql.replace(/\s+/g, " ").trim();
const SCOPE = { courses: [5, 8], drafts: [3] };

// The statement each caller sent through its widened-scan transaction.
const hybridSent = async (run) => {
  const q = stubPoolQuery(pool, () => ({ rows: [] }));
  const c = stubPoolConnect(pool, () => ({ rows: [{ id: 1, media_id: 5, chunk_index: 0, content: "x" }] }));
  try {
    await run();
    const call = c.calls.find(({ text }) => /\bfused\b/.test(text));
    assert.ok(call, "the hybrid statement ran");
    return call;
  } finally {
    q.restore();
    c.restore();
  }
};

test("each ranking filters by the caller's visibility before it takes its candidates", () => {
  const sql = flat(hybridSearchSql("c.id", 7));
  for (const name of ["kw", "vec"]) {
    const start = sql.indexOf(`${name} AS (`);
    assert.notEqual(start, -1, `the ${name} ranking exists`);
    const cte = sql.slice(start, sql.indexOf(`LIMIT ${FUSE_DEPTH}`, start));
    assert.match(cte, /is_published/, `${name} applies the visibility rule`);
    assert.match(cte, /\$3::int\[\]/, `${name} reads the courses`);
    assert.match(cte, /\$4::int\[\]/, `${name} reads the drafts`);
  }
  assert.match(sql, /SELECT c\.id FROM fused f .* ORDER BY f\.score DESC LIMIT 7$/, "the caller's columns and limit");
});

test("the library search and the archive chat send one statement, differing only in what they read back", async () => {
  const library = await hybridSent(() => searchTranscripts("תשובה", "hybrid", SCOPE));
  const archive = await hybridSent(() => searchArchive("תשובה", SCOPE));

  // Everything up to the final SELECT — the rankings, the visibility, the fusion.
  const rankings = (sql) => flat(sql).slice(0, flat(sql).lastIndexOf(") SELECT"));
  assert.ok(rankings(library.text).length > 500, "the rankings were found");
  assert.equal(rankings(archive.text), rankings(library.text));

  for (const call of [library, archive]) {
    assert.equal(call.params.length, 4);
    assert.equal(call.params[0], "תשובה", "$1 the query text");
    assert.match(call.params[1], /^\[.*\]$/, "$2 the query embedding");
    assert.deepEqual(call.params.slice(2), [SCOPE.courses, SCOPE.drafts], "$3, $4 the scope");
  }
  assert.match(flat(library.text), /LIMIT 40$/, "the library search keeps 40 candidates for its rerank");
  assert.match(flat(archive.text), /LIMIT 16$/, "the archive chat 16");
  assert.match(library.text, /AS headline/, "a search result carries its highlighted snippet");
  assert.match(archive.text, /c\.page_number/, "a passage carries its place in a book");
});
