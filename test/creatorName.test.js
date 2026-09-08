import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { createMedia, updateMedia, DEFAULT_CREATOR } from "../services/servicesMedia.js";

// Attribution: "who said this", stored as words rather than as an account.
//
// The rules live in servicesMedia rather than in the controller so that anything
// writing a media row gets them, which is exactly what these tests exercise —
// they call the service directly, with no request anywhere.

// Captures what the service actually sent to Postgres. The INSERT and the UPDATE
// name their columns positionally, so the assertions below read the parameter
// array rather than trying to parse SQL.
const capture = () => {
  const calls = [];
  stubPoolQuery(pool, async (text, params) => {
    calls.push({ text, params });
    // updateMedia re-reads through getMediaById, so every query has to answer
    // with a row or it throws notFound before the assertion runs.
    return { rows: [{ id: 1 }] };
  });
  return calls;
};

const BASE = {
  uploaderId: 1,
  title: "שיעור",
  description: "",
  mediaType: "audio",
  s3Key: "local/x.mp3",
};

// ── Creating ────────────────────────────────────────────────────────────────

test("an upload with no creator name stores the default", async () => {
  const calls = capture();
  await createMedia({ ...BASE });
  assert.equal(calls[0].params.at(-1), DEFAULT_CREATOR);
});

test("an empty or whitespace-only name stores the default", async () => {
  for (const blank of ["", "   ", "\t\n", null, undefined]) {
    const calls = capture();
    await createMedia({ ...BASE, creatorName: blank });
    assert.equal(calls[0].params.at(-1), DEFAULT_CREATOR, `blank was ${JSON.stringify(blank)}`);
  }
});

// A name of " " would otherwise become a distinct creator that sorts to the top
// of every filter list and cannot be typed again.
test("a name is trimmed before it is stored", async () => {
  const calls = capture();
  await createMedia({ ...BASE, creatorName: "  הרב כהן  " });
  assert.equal(calls[0].params.at(-1), "הרב כהן");
});

test("a name longer than the column is refused with a 400, not a driver error", async () => {
  capture();
  await assert.rejects(
    () => createMedia({ ...BASE, creatorName: "x".repeat(121) }),
    (err) => err.statusCode === 400
  );
});

test("a name exactly at the limit is accepted", async () => {
  const calls = capture();
  const name = "x".repeat(120);
  await createMedia({ ...BASE, creatorName: name });
  assert.equal(calls[0].params.at(-1), name);
});

// The INSERT names every column, so the column DEFAULT never fires — the service
// is what has to supply the value. If this ever regresses, rows arrive with NULL
// against a NOT NULL column and every upload fails at the driver.
test("the insert names creator_name and always binds a value", async () => {
  const calls = capture();
  await createMedia({ ...BASE });
  assert.match(calls[0].text, /creator_name/);
  assert.equal(typeof calls[0].params.at(-1), "string");
});

// ── Updating ────────────────────────────────────────────────────────────────

// COALESCE semantics: the field is only touched when the caller mentions it.
test("an update that omits the name leaves it alone", async () => {
  const calls = capture();
  await updateMedia(1, { title: "חדש" });
  assert.equal(calls[0].params.at(-1), null);
});

test("an update can change the name", async () => {
  const calls = capture();
  await updateMedia(1, { creatorName: "הרב לוי" });
  assert.equal(calls[0].params.at(-1), "הרב לוי");
});

// Clearing the field is a real thing an editor does, and the column is NOT NULL,
// so it has to land on the default rather than fail.
test("clearing the name in an edit falls back to the default", async () => {
  const calls = capture();
  await updateMedia(1, { creatorName: "   " });
  assert.equal(calls[0].params.at(-1), DEFAULT_CREATOR);
});

test("an over-long name is refused on update too", async () => {
  capture();
  await assert.rejects(
    () => updateMedia(1, { creatorName: "x".repeat(121) }),
    (err) => err.statusCode === 400
  );
});
