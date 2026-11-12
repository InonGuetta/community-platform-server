import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  requireSeconds, optionalSeconds, optionalId, optionalBoolean, mediaTypeFilter,
  mediaSortFilter, MEDIA_SORTS, DEFAULT_MEDIA_SORT, durationRangeFilter,
  optionalDateFilter, optionalQueryString, requireTitle, optionalTitle, optionalIntInRange,
  sessionTypeFilter, optionalSessionStart, MIN_SESSION_LEAD_MS, MAX_SESSION_LEAD_MS,
} from "../lib/validate.js";
import { MEDIA_ORDER } from "../services/servicesMedia.js";

const rejects = (fn) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err.statusCode === 400;
  }
};

test("requireSeconds accepts real positions", () => {
  assert.equal(requireSeconds(0, "x"), 0);
  assert.equal(requireSeconds(12.9, "x"), 12, "fractional seconds floor");
  assert.equal(requireSeconds("42", "x"), 42, "form data arrives as strings");
});

test("requireSeconds rejects anything that is not a position", () => {
  for (const bad of ["abc", -1, undefined, NaN, Infinity, ""]) {
    assert.ok(rejects(() => requireSeconds(bad, "x")), `${String(bad)} should be a 400`);
  }
});

// Number(null) is 0, so without an explicit guard a missing position silently
// saved as "back to the start" and wiped the viewer's place in a lecture.
test("requireSeconds rejects null rather than reading it as zero", () => {
  assert.ok(rejects(() => requireSeconds(null, "positionSeconds")));
});

test("optionalSeconds distinguishes absent from zero", () => {
  assert.equal(optionalSeconds(undefined, "x"), null);
  assert.equal(optionalSeconds(null, "x"), null);
  assert.equal(optionalSeconds(0, "x"), 0, "zero is a real timestamp, not 'absent'");
  assert.ok(rejects(() => optionalSeconds("bad", "x")));
});

test("optionalId only accepts positive integers", () => {
  assert.equal(optionalId(undefined, "x"), null);
  assert.equal(optionalId("7", "x"), 7);
  for (const bad of [0, -3, 1.5, "abc"]) {
    assert.ok(rejects(() => optionalId(bad, "x")), `${String(bad)} should be a 400`);
  }
});

test("optionalBoolean does not coerce", () => {
  assert.equal(optionalBoolean(undefined, "x"), null, "absent leaves the column alone");
  assert.equal(optionalBoolean(false, "x"), false, "false is a value, not an absence");
  assert.ok(rejects(() => optionalBoolean("true", "x")), "a string is not a boolean");
});

// ── mediaTypeFilter ─────────────────────────────────────────────────────────

test("mediaTypeFilter reads one type or several, and absent as none", () => {
  assert.deepEqual(mediaTypeFilter("video"), ["video"]);
  assert.deepEqual(mediaTypeFilter(["video", "audio"]), ["video", "audio"]);
  assert.deepEqual(mediaTypeFilter(["video", "video"]), ["video"]);
  assert.deepEqual(mediaTypeFilter(undefined), []);
  assert.deepEqual(mediaTypeFilter(""), []);
});

// Passed through, an unknown type reaches an enum column and becomes a 500.
test("mediaTypeFilter refuses a type that does not exist", () => {
  assert.ok(rejects(() => mediaTypeFilter("banana")));
  assert.ok(rejects(() => mediaTypeFilter(["video", "banana"])));
});

// ── mediaSortFilter ─────────────────────────────────────────────────────────

test("mediaSortFilter reads each order by name, and absent as newest first", () => {
  for (const name of MEDIA_SORTS) assert.equal(mediaSortFilter(name), name);
  assert.equal(mediaSortFilter(undefined), DEFAULT_MEDIA_SORT);
  assert.equal(mediaSortFilter(""), DEFAULT_MEDIA_SORT);
  assert.equal(DEFAULT_MEDIA_SORT, "newest");
});

// The name selects fixed SQL; anything else must never get as far as that.
test("mediaSortFilter refuses an order that does not exist, or is not one value", () => {
  assert.ok(rejects(() => mediaSortFilter("banana")));
  assert.ok(rejects(() => mediaSortFilter("created_at; DROP TABLE media_items")));
  assert.ok(rejects(() => mediaSortFilter(["title", "liked"])));
  assert.ok(rejects(() => mediaSortFilter("Title")));
});

// The two lists are one idea in two files: a name accepted here with no ORDER
// BY behind it would silently fall back to newest-first.
test("every accepted order has SQL behind it, and every SQL order is accepted", () => {
  assert.deepEqual(Object.keys(MEDIA_ORDER).sort(), [...MEDIA_SORTS].sort());
});

test("every order ends on the same tie-break, so equal rows keep their places", () => {
  for (const [name, sql] of Object.entries(MEDIA_ORDER)) {
    assert.match(sql, /m\.id (ASC|DESC)$/, `${name} has no final tie-break on id`);
  }
});

// ── durationRangeFilter ─────────────────────────────────────────────────────

test("durationRangeFilter reads either end, both, or neither", () => {
  assert.deepEqual(durationRangeFilter(undefined, undefined), { min: null, max: null });
  assert.deepEqual(durationRangeFilter("900", undefined), { min: 900, max: null });
  assert.deepEqual(durationRangeFilter(undefined, "900"), { min: null, max: 900 });
  assert.deepEqual(durationRangeFilter("900", "1800"), { min: 900, max: 1800 });
  assert.deepEqual(durationRangeFilter("0", "900"), { min: 0, max: 900 });
});

// Number() would read every one of these as some number the caller did not
// quite ask for.
test("durationRangeFilter refuses anything that is not a whole number of seconds", () => {
  for (const bad of ["abc", "1e3", "-5", "12.5", " 5", "99999999999"]) {
    assert.ok(rejects(() => durationRangeFilter(bad, undefined)), `min=${bad}`);
    assert.ok(rejects(() => durationRangeFilter(undefined, bad)), `max=${bad}`);
  }
  assert.ok(rejects(() => durationRangeFilter(["900", "60"], undefined)));
});

// An empty range answers with nothing, which reads as the filter being broken.
test("durationRangeFilter refuses a range with no room in it", () => {
  assert.ok(rejects(() => durationRangeFilter("1800", "900")));
  assert.ok(rejects(() => durationRangeFilter("900", "900")));
});

// ── The archive's date and text filters ─────────────────────────────────────
//
// These reached Postgres unchecked, so ?uploadedAfter=abc — or a parameter given
// twice, which Express hands over as an array — was a 500 from the driver.

test("a date filter accepts YYYY-MM-DD and treats empty as absent", () => {
  assert.equal(optionalDateFilter("2024-03-05", "from"), "2024-03-05");
  assert.equal(optionalDateFilter(undefined, "from"), undefined);
  assert.equal(optionalDateFilter("", "from"), undefined);
});

test("a date filter refuses free text, impossible dates and arrays", () => {
  for (const bad of ["abc", "2024-02-30", "2024-3-5", ["2024-03-05", "2024-03-06"], 20240305]) {
    assert.throws(() => optionalDateFilter(bad, "from"), { statusCode: 400 }, JSON.stringify(bad));
  }
});

test("a text filter must be one string of bounded length", () => {
  assert.equal(optionalQueryString("הרב כהן", "creator"), "הרב כהן");
  assert.equal(optionalQueryString(undefined, "creator"), undefined);
  assert.throws(() => optionalQueryString(["a", "b"], "creator"), { statusCode: 400 });
  assert.throws(() => optionalQueryString("x".repeat(301), "creator"), { statusCode: 400 });
});

const messageOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.statusCode === 400 ? err.message : `not a 400: ${err.message}`;
  }
};

test("requireTitle trims, names what is missing, and holds its column's length", () => {
  assert.equal(requireTitle("  גמרא  ", "Course", 255), "גמרא");
  assert.equal(messageOf(() => requireTitle("   ", "Course", 255)), "Course title is required");
  assert.equal(messageOf(() => requireTitle(undefined, "List", 120)), "List title is required");
  assert.equal(messageOf(() => requireTitle(42, "List", 120)), "List title is required");
  assert.equal(requireTitle("x".repeat(120), "List", 120).length, 120);
  assert.equal(messageOf(() => requireTitle("x".repeat(121), "List", 120)), "Title must be at most 120 characters");
});

test("optionalTitle answers an empty string for nothing, and holds the length", () => {
  assert.equal(optionalTitle(undefined, 255), "");
  assert.equal(optionalTitle("  שיעור ", 255), "שיעור");
  assert.equal(messageOf(() => optionalTitle("x".repeat(256), 255)), "Title must be at most 255 characters");
});

test("optionalIntInRange reads numbers and numeric strings, and null as absent", () => {
  assert.equal(optionalIntInRange(undefined, "n", 1, 100), null);
  assert.equal(optionalIntInRange(null, "n", 1, 100), null);
  assert.equal(optionalIntInRange("12", "n", 1, 100), 12);
  assert.equal(optionalIntInRange(100, "n", 1, 100), 100);
  for (const bad of [0, 101, 1.5, "abc", ""]) {
    assert.equal(messageOf(() => optionalIntInRange(bad, "maxParticipants", 1, 100)), "maxParticipants must be a whole number between 1 and 100");
  }
});

test("sessionTypeFilter accepts the enum's three and names anything else", () => {
  for (const type of ["1on1", "group", "webinar"]) assert.equal(sessionTypeFilter(type), type);
  assert.equal(messageOf(() => sessionTypeFilter("party")), 'Invalid session type: "party"');
  assert.equal(messageOf(() => sessionTypeFilter(undefined)), 'Invalid session type: "undefined"');
});

test("optionalSessionStart is null for nothing, and a real date between a minute and a year ahead", () => {
  const now = Date.parse("2026-11-12T10:00:00Z");
  assert.equal(optionalSessionStart(undefined, now), null);
  assert.equal(optionalSessionStart("", now), null);
  // A time with a zone comes back as UTC ISO: 14:30 in Israel is 12:30Z.
  assert.equal(optionalSessionStart("2026-11-12T14:30:00+02:00", now), "2026-11-12T12:30:00.000Z");
  assert.equal(optionalSessionStart(new Date(now + MIN_SESSION_LEAD_MS).toISOString(), now), new Date(now + MIN_SESSION_LEAD_MS).toISOString());
  assert.equal(optionalSessionStart(new Date(now + MAX_SESSION_LEAD_MS).toISOString(), now), new Date(now + MAX_SESSION_LEAD_MS).toISOString());
  assert.equal(messageOf(() => optionalSessionStart("soon", now)), "scheduledAt must be a valid date");
  assert.equal(messageOf(() => optionalSessionStart(new Date(now + MIN_SESSION_LEAD_MS - 1).toISOString(), now)), "A scheduled session must be at least a minute away");
  assert.equal(messageOf(() => optionalSessionStart(new Date(now + MAX_SESSION_LEAD_MS + 1).toISOString(), now)), "A session cannot be scheduled more than a year ahead");
});
