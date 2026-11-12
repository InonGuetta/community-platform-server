import test from "node:test";
import assert from "node:assert/strict";
import { sessionCalendar, foldLine, DEFAULT_DURATION_MINUTES } from "../lib/ics.js";

const SESSION = {
  id: 12,
  title: "שיעור, בגמרא; פרק ב",
  startsAt: new Date("2026-11-03T17:30:00Z"),
  hostName: "הרב כהן",
  url: "http://localhost:5173/sessions",
  domain: "localhost",
  now: new Date("2026-11-01T10:00:00Z"),
};

const unfold = (ics) => ics.replace(/\r\n /g, "");
const lines = (ics) => unfold(ics).split("\r\n");

test("one event, in UTC, an hour long", () => {
  const all = lines(sessionCalendar(SESSION));
  assert.equal(all[0], "BEGIN:VCALENDAR");
  assert.ok(all.includes("DTSTART:20261103T173000Z"));
  assert.equal(DEFAULT_DURATION_MINUTES, 60);
  assert.ok(all.includes("DTEND:20261103T183000Z"));
  assert.ok(all.includes("DTSTAMP:20261101T100000Z"));
  assert.ok(all.includes("UID:session-12@localhost"), "stable, so a second import updates the same event");
});

test("TEXT values escape commas, semicolons and newlines", () => {
  const all = lines(sessionCalendar(SESSION));
  assert.ok(all.includes("SUMMARY:שיעור\\, בגמרא\\; פרק ב"));
  assert.ok(all.includes("DESCRIPTION:מארח: הרב כהן\\nhttp://localhost:5173/sessions"));
});

test("every line ends in CRLF, and so does the file", () => {
  const ics = sessionCalendar(SESSION);
  assert.ok(ics.endsWith("END:VCALENDAR\r\n"));
  assert.equal(/[^\r]\n/.test(ics), false, "a bare LF");
});

// A Hebrew letter is two bytes: folding by character count makes lines of up
// to 150 bytes, and a split inside a letter corrupts it.
test("lines are folded at 75 octets, between characters", () => {
  const long = foldLine(`SUMMARY:${"א".repeat(100)}`);
  for (const physical of long.split("\r\n")) {
    assert.ok(Buffer.byteLength(physical, "utf8") <= 75, `${Buffer.byteLength(physical, "utf8")} octets`);
  }
  assert.equal(long.replace(/\r\n /g, ""), `SUMMARY:${"א".repeat(100)}`, "unfolding restores the line exactly");
});

test("a short line is left alone", () => {
  assert.equal(foldLine("VERSION:2.0"), "VERSION:2.0");
});

test("an untitled session still has a summary", () => {
  assert.ok(lines(sessionCalendar({ ...SESSION, title: null })).includes("SUMMARY:מפגש חי"));
});
