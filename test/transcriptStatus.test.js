import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import {
  markPending, markProcessing, markAnalyzing, markDone, markDoneUnlessAnalyzing, markFailed,
} from "../services/transcripts/status.js";
import { getMediaSource } from "../services/servicesMedia.js";
import { attemptsAllowed, isFinalAttempt } from "../queue/workers/jobAttempts.js";
import { serverSourceFiles } from "./sourceFiles.js";

// transcripts.status — the contract with the page — written in one module.
// The statements below are the ones the workers, triggerPipeline and the
// headings feature sent before the writes moved there; each transition must
// still send exactly that.

const flat = (sql) => sql.replace(/\s+/g, " ").trim();

const sent = async (call) => {
  const db = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    await call();
    assert.equal(db.calls.length, 1);
    return { sql: flat(db.calls[0].text), params: db.calls[0].params };
  } finally {
    db.restore();
  }
};

test("pending: the row is created or reset, with the last run's reason cleared", async () => {
  assert.deepEqual(await sent(() => markPending(7)), {
    sql: "INSERT INTO transcripts (media_id, status) VALUES ($1, 'pending') ON CONFLICT (media_id) DO UPDATE SET status='pending', error_message=NULL, updated_at=NOW()",
    params: [7],
  });
});

test("processing", async () => {
  assert.deepEqual(await sent(() => markProcessing(7)), {
    sql: "UPDATE transcripts SET status='processing', updated_at=NOW() WHERE media_id=$1",
    params: [7],
  });
});

test("analyzing — with a book's text quality only when one is given, null included", async () => {
  assert.deepEqual(await sent(() => markAnalyzing(7)), {
    sql: "UPDATE transcripts SET status='analyzing', updated_at=NOW() WHERE media_id=$1",
    params: [7],
  });
  const withQuality = "UPDATE transcripts SET status='analyzing', text_quality=$2, updated_at=NOW() WHERE media_id=$1";
  assert.deepEqual(await sent(() => markAnalyzing(7, { textQuality: 83 })), { sql: withQuality, params: [7, 83] });
  assert.deepEqual(await sent(() => markAnalyzing(7, { textQuality: null })), { sql: withQuality, params: [7, null] });
});

test("done is written in the same statement as the summary", async () => {
  assert.deepEqual(await sent(() => markDone(7, { summary: "סיכום", keyPoints: ["א", "ב"] })), {
    sql: "UPDATE transcripts SET ai_summary=$1, ai_key_points=$2, status='done', error_message=NULL, updated_at=NOW() WHERE media_id=$3",
    params: ["סיכום", JSON.stringify(["א", "ב"]), 7],
  });
});

test("an on-demand analysis leaves a row still at 'analyzing' alone", async () => {
  assert.deepEqual(await sent(() => markDoneUnlessAnalyzing(7, { summary: "s", keyPoints: ["k"] })), {
    sql: "UPDATE transcripts SET ai_summary=$1, ai_key_points=$2, status = CASE WHEN status = 'analyzing' THEN status ELSE 'done' END, updated_at=NOW() WHERE media_id=$3",
    params: ["s", JSON.stringify(["k"]), 7],
  });
});

test("error — the stored reason is replaced only when one is given, null included", async () => {
  assert.deepEqual(await sent(() => markFailed(7)), {
    sql: "UPDATE transcripts SET status='error', updated_at=NOW() WHERE media_id=$1",
    params: [7],
  });
  const withReason = "UPDATE transcripts SET status='error', error_message=$1, updated_at=NOW() WHERE media_id=$2";
  assert.deepEqual(await sent(() => markFailed(7, { errorMessage: "לא נמצא טקסט קריא בקובץ." })), {
    sql: withReason, params: ["לא נמצא טקסט קריא בקובץ.", 7],
  });
  assert.deepEqual(await sent(() => markFailed(7, { errorMessage: null })), { sql: withReason, params: [null, 7] });
});

test("the LLM worker reads a lesson's kind and file through the media service", async () => {
  const db = stubPoolQuery(pool, () => ({ rows: [{ media_type: "text", s3_key: "local/b.pdf" }] }));
  try {
    assert.deepEqual(await getMediaSource(9), { media_type: "text", s3_key: "local/b.pdf" });
    assert.equal(flat(db.calls[0].text), "SELECT media_type, s3_key FROM media_items WHERE id=$1");
    assert.deepEqual(db.calls[0].params, [9]);
  } finally {
    db.restore();
  }
  const gone = stubPoolQuery(pool, () => ({ rows: [] }));
  try {
    assert.equal(await getMediaSource(9), null);
  } finally {
    gone.restore();
  }
});

// ── The last attempt ────────────────────────────────────────────────────────

test("a job's last attempt is the one after attempts-1 have failed", () => {
  assert.equal(attemptsAllowed({}), 1);
  assert.equal(attemptsAllowed({ opts: { attempts: 3 } }), 3);
  assert.equal(isFinalAttempt({ attemptsMade: 0 }), true, "one attempt by default");
  assert.equal(isFinalAttempt({ attemptsMade: 0, opts: { attempts: 3 } }), false);
  assert.equal(isFinalAttempt({ attemptsMade: 1, opts: { attempts: 3 } }), false);
  assert.equal(isFinalAttempt({ attemptsMade: 2, opts: { attempts: 3 } }), true);
});

// ── Written in one place ────────────────────────────────────────────────────

const STATUS_MODULE = path.join("services", "transcripts", "status.js");

test("only services/transcripts/status.js writes transcripts.status", async () => {
  const files = await serverSourceFiles();
  assert.ok(files.length > 50, `only ${files.length} source files found`);
  const writers = [];
  for (const { file, source } of files) {
    if (file === STATUS_MODULE) continue;
    for (const match of source.matchAll(/(UPDATE|INSERT INTO)\s+transcripts\b[^`"]{0,700}/g)) {
      // \bstatus — so hebrew_fix_status and headings_status, an action's own
      // status (aiActions.js), are not mistaken for the pipeline's.
      if (/\bstatus\s*=/.test(match[0]) || /\(media_id, status\)/.test(match[0])) writers.push(file);
    }
  }
  assert.deepEqual(writers, [], `write the status through status.js: ${writers.join(", ")}`);
});

test("the workers send no SQL of their own", async () => {
  const files = (await serverSourceFiles()).filter(({ file }) => file.startsWith(`queue${path.sep}`));
  assert.ok(files.length >= 4, `only ${files.length} queue files found`);
  const querying = files.filter(({ source }) => /\bpool\.(query|connect)\(/.test(source)).map(({ file }) => file);
  assert.deepEqual(querying, [], `go through a service instead: ${querying.join(", ")}`);
});
