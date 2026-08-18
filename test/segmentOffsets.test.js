import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { parseSegmentStarts, assumedSegmentStarts } from "../queue/workers/segmentOffsets.js";

// Every timestamp in a transcript is built on these numbers: a search hit's
// "jump to this moment", and the start_time each AI key point is snapped to. They
// are also the kind of wrong that never announces itself — the transcript reads
// perfectly, it just points slightly to the left of what it describes.

// What ffmpeg's segment muxer writes with -segment_list_type csv: one row per
// piece, filename,start,end, and the ends do not land on round numbers because
// the muxer cuts on frame boundaries.
const REAL_LIST = [
  "chunk000.mp3,0.000000,600.024000",
  "chunk001.mp3,600.024000,1200.048000",
  "chunk002.mp3,1200.048000,1523.712000",
].join("\n");

test("the starts come from the list, not from an even division", () => {
  const starts = parseSegmentStarts(REAL_LIST, 3);
  assert.deepEqual(starts, [0, 600.024, 1200.048]);
});

// The bug this replaced, stated as an assertion: the assumed offsets and the real
// ones diverge, they diverge in one direction, and the gap grows with every
// segment. On a long lecture that is where the timestamps quietly slide.
test("the assumed offsets drift further behind with each segment", () => {
  const real = parseSegmentStarts(REAL_LIST, 3);
  const assumed = assumedSegmentStarts(3, 600);

  assert.equal(real[0] - assumed[0], 0, "the first segment is the one place the assumption holds");
  assert.ok(real[1] - assumed[1] > 0);
  assert.ok(real[2] - assumed[2] > real[1] - assumed[1], "the error accumulates rather than cancelling");
});

test("a trailing newline does not invent a segment", () => {
  assert.deepEqual(parseSegmentStarts(`${REAL_LIST}\n`, 3), [0, 600.024, 1200.048]);
});

test("a single-segment recording is not a special case", () => {
  assert.deepEqual(parseSegmentStarts("chunk000.mp3,0.000000,412.800000", 1), [0]);
});

// ── When the list cannot be trusted, say so rather than guess ───────────────
//
// null is the signal for "fall back to the assumed offsets". Returning a partial
// or padded answer would be worse than the arithmetic it replaced, because it
// would look measured.

test("a list that does not cover every segment is rejected", () => {
  assert.equal(parseSegmentStarts(REAL_LIST, 4), null, "fewer rows than files on disk");
  assert.equal(parseSegmentStarts(REAL_LIST, 2), null, "more rows than files on disk");
});

test("an unparseable list is rejected", () => {
  for (const bad of ["", null, undefined, "not,a,list", "chunk000.mp3\nchunk001.mp3"]) {
    assert.equal(parseSegmentStarts(bad, 2), null, `${String(bad)} should not be read as offsets`);
  }
});

// Starts that move backwards, or repeat, mean the columns are not the ones
// assumed here. Using them would scatter timestamps across the recording instead
// of merely shifting them, which is the one outcome worse than the original bug.
test("starts that do not advance are rejected", () => {
  const backwards = ["a.mp3,0.0,600.0", "b.mp3,600.0,1200.0", "c.mp3,300.0,900.0"].join("\n");
  assert.equal(parseSegmentStarts(backwards, 3), null);

  const repeated = ["a.mp3,0.0,600.0", "b.mp3,0.0,600.0"].join("\n");
  assert.equal(parseSegmentStarts(repeated, 2), null);
});

test("a first segment that does not start at zero is rejected", () => {
  // A recording begins at its beginning. Anything else says the second column is
  // not the start time.
  const shifted = ["a.mp3,12.5,600.0", "b.mp3,600.0,1200.0"].join("\n");
  assert.equal(parseSegmentStarts(shifted, 2), null);
});

test("a negative start is rejected", () => {
  const negative = ["a.mp3,-1.0,600.0", "b.mp3,600.0,1200.0"].join("\n");
  assert.equal(parseSegmentStarts(negative, 2), null);
});

test("the fallback is exactly the arithmetic it replaced", () => {
  // Unchanged behaviour is the promise of the fallback path, so it is pinned.
  assert.deepEqual(assumedSegmentStarts(3, 600), [0, 600, 1200]);
  assert.deepEqual(assumedSegmentStarts(0, 600), []);
});
