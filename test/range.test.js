import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { parseRange, RANGE_UNSATISFIABLE } from "../controllers/controllersMedia.js";

const describe = (v) => (v === RANGE_UNSATISFIABLE ? "416" : v === null ? "whole file" : `${v.start}-${v.end}`);
const at = (header, size) => describe(parseRange(header, size));

test("no usable Range header means send the whole file", () => {
  for (const header of [undefined, "", "abc", "bytes="]) {
    assert.equal(at(header, 1000), "whole file", `header ${JSON.stringify(header)}`);
  }
});

test("ordinary player requests", () => {
  assert.equal(at("bytes=0-", 1000), "0-999", "open-ended from the start");
  assert.equal(at("bytes=0-99", 1000), "0-99");
  assert.equal(at("bytes=500-", 1000), "500-999", "seeking forward");
  assert.equal(at("bytes=999-999", 1000), "999-999", "the final byte");
});

// Players routinely send a deliberately huge end value meaning "the rest".
// Answering 416 to those is what broke seeking.
test("an end past the file is clamped, not rejected", () => {
  assert.equal(at("bytes=500-99999999", 1000), "500-999");
  assert.equal(at("bytes=0-1000", 1000), "0-999", "end == size is still satisfiable");
});

// "bytes=-500" means the LAST 500 bytes; it used to be read as 0-500.
test("a suffix range counts back from the end", () => {
  assert.equal(at("bytes=-500", 1000), "500-999");
  assert.equal(at("bytes=-99999", 1000), "0-999", "longer than the file is the whole file");
  assert.equal(at("bytes=-0", 1000), "416", "a zero-length suffix is unsatisfiable");
});

test("genuinely unsatisfiable ranges return 416", () => {
  assert.equal(at("bytes=1000-", 1000), "416", "starts past the end");
  assert.equal(at("bytes=5000-6000", 1000), "416");
  assert.equal(at("bytes=100-50", 1000), "416", "inverted");
});

test("edge-sized files", () => {
  assert.equal(at("bytes=0-", 0), "416", "an empty file satisfies nothing");
  assert.equal(at("bytes=0-0", 1), "0-0");
});

// Documents current behaviour rather than endorsing it: multi-range requests
// fall through to a normal 200 with the entire body, which is acceptable.
test("a multi-range request falls back to the whole file", () => {
  assert.equal(at("bytes=0-100,200-300", 1000), "whole file");
});
