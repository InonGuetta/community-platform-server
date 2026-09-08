import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { suggestTags } from "../lib/tagSuggestions.js";

// Guessing what a shiur is about from what it is called.
//
// The titles below are the archive's REAL ones, and the expectations are what a
// person actually chose for them by hand. That is the point of this file: the
// rule was written down from a procedure somebody followed, so the procedure's
// own answers are what it has to reproduce.
//
// Where the two disagree it is stated as a disagreement rather than hidden — the
// interesting cases are the ones where the rule offers something a person would
// not have, because a suggestion is rejected with one click and a silent
// mis-filing is found months later by nobody.

// A slice of the real taxonomy, with the real shapes that matter: a name that
// occurs twice (דברים as a book and as a parasha inside it), two parashot whose
// spellings collapse into each other, and headings whose wording is nothing like
// how anyone titles a shiur.
const TAGS = [
  { id: 1, name: 'תנ"ך', parent_id: null },
  { id: 2, name: "תורה", parent_id: 1 },
  { id: 3, name: "בראשית", parent_id: 2 },
  { id: 15, name: "ויחי", parent_id: 3 },
  { id: 16, name: "שמות", parent_id: 2 },
  { id: 25, name: "כי תשא", parent_id: 16 },
  { id: 28, name: "ויקרא", parent_id: 2 },
  { id: 37, name: "בהר", parent_id: 28 },
  { id: 38, name: "בחוקותי", parent_id: 28 },
  { id: 44, name: "במדבר", parent_id: 2 },
  { id: 45, name: "חוקת", parent_id: 44 },
  { id: 50, name: "דברים", parent_id: 2 },
  { id: 51, name: "דברים", parent_id: 50 },
  { id: 57, name: "כי תבוא", parent_id: 50 },
  { id: 96, name: "משנה", parent_id: null },
  { id: 130, name: "נזיקין", parent_id: 96 },
  { id: 134, name: "סנהדרין", parent_id: 130 },
  { id: 192, name: "מוסר וחסידות", parent_id: null },
  { id: 193, name: "בין אדם למקום", parent_id: 192 },
  { id: 194, name: "אמונה ובטחון", parent_id: 193 },
  { id: 196, name: "תשובה", parent_id: 193 },
  { id: 199, name: "בין אדם לחברו", parent_id: 192 },
  { id: 201, name: "כבוד הבריות", parent_id: 199 },
  { id: 205, name: "יהדות והשקפה", parent_id: null },
  { id: 206, name: "אמונה והשקפה", parent_id: 205 },
  { id: 219, name: "חיזוק", parent_id: 205 },
  { id: 220, name: "חיזוק כללי", parent_id: 219 },
];

const names = (title, description = "") =>
  suggestTags({ title, description }, TAGS).map((s) => s.name);

// ── What the taxonomy already has words for ─────────────────────────────────

test("a parasha named in the title is offered", () => {
  assert.deepEqual(names("פרשת ויחי הרב אברהם וינברג"), ["ויחי"]);
});

test("two parashot in one title are both offered", () => {
  assert.deepEqual(names("פרשת בהר בחוקותי").sort(), ["בהר", "בחוקותי"]);
});

// The bug that made half the archive untagged on the first attempt: ב is both a
// preposition and the first letter of a parasha, and stripping it blindly turned
// בהר into הר.
test("a name that begins with a preposition letter is still a name", () => {
  assert.ok(names("פרשת בהר").includes("בהר"));
  assert.ok(names("בחוקותי תלכו").includes("בחוקותי"));
});

test("a glued preposition does not hide the name behind it", () => {
  assert.ok(names("שיעור בבראשית").includes("בראשית"));
});

// Hebrew is written with and without its vowel letters, and a title uses
// whichever the person typed.
test("a spelling without the vowel letters still finds the tag", () => {
  assert.ok(names("הרב מאיר אליהו פרשת כי תבא").includes("כי תבוא"));
});

// ...but the collapse is blunt, and two different parashot in two different
// books must not become each other.
test("the spelling fallback does not merge two different names", () => {
  assert.ok(!names("בחוקותי תלכו").includes("חוקת"));
});

// ── The same name in two places ─────────────────────────────────────────────
//
// This is the error the hand-tagging made: a commentary on the whole book of
// דברים was filed under the parasha of the same name.

test("a title that says nothing gets the broader of two identical names", () => {
  const suggested = suggestTags({ title: "תורה תמימה דברים" }, TAGS);
  const book = suggested.find((s) => s.name === "דברים");
  assert.equal(book.id, 50, "the book, not the parasha inside it");
});

test('a title that says "פרשת" gets the parasha', () => {
  const suggested = suggestTags({ title: "שיעור על פרשת דברים" }, TAGS);
  const parasha = suggested.find((s) => s.name === "דברים");
  assert.equal(parasha.id, 51);
});

// ── Subjects the taxonomy words differently ─────────────────────────────────

test("a practice is offered under the heading it belongs to", () => {
  assert.deepEqual(names("חשבון נפש הרב פייבלזון"), ["תשובה"]);
});

test("a topic nobody titles the way the tree words it is still found", () => {
  assert.deepEqual(names("לאומיות ודת"), ["אמונה והשקפה"]);
  assert.deepEqual(names("השקפה ואקטואליה"), ["אמונה והשקפה"]);
});

test("the description is read as well as the title", () => {
  const suggested = names("הרב מאיר אליהו פרשת כי תבא", "פרשת כי תבא וכיבוד הורים");
  assert.ok(suggested.includes("כבוד הבריות"), "כיבוד הורים lives under a differently-worded heading");
  assert.ok(suggested.includes("כי תבוא"));
});

// ── What it refuses to guess ────────────────────────────────────────────────

test("a title that says nothing about content gets nothing", () => {
  assert.deepEqual(names("check"), []);
  assert.deepEqual(names("בדיקה קטע שמע ארוך"), []);
  assert.deepEqual(names("אוכל בריא"), []);
});

// Where the rule and the person disagreed, and the rule is the better of the
// two: "לעשות חיים" says nothing, and the hand-tagging guessed anyway.
test("it offers nothing where a person guessed", () => {
  assert.deepEqual(names("הרב שי פרי לעשות חיים"), []);
});

test("an empty item and an empty vocabulary are both simply nothing", () => {
  assert.deepEqual(suggestTags({}, TAGS), []);
  assert.deepEqual(suggestTags({ title: "פרשת ויחי" }, []), []);
  assert.deepEqual(suggestTags(undefined, TAGS), []);
});

// ── What comes back with each suggestion ────────────────────────────────────

test("every suggestion carries where it sits and why it was offered", () => {
  const [first] = suggestTags({ title: "פרשת ויחי" }, TAGS);
  assert.equal(first.name, "ויחי");
  assert.match(first.path, /תנ"ך ← תורה ← בראשית/, "the path disambiguates repeated names");
  assert.ok(first.reason.length > 0, "a suggestion nobody can check is one nobody should accept");
});

// An item may carry eight tags in total; a list longer than a handful stops
// being a suggestion and becomes an audit.
test("it offers a handful at most", () => {
  const busy = "פרשת ויחי כי תשא בהר בחוקותי כי תבוא חשבון נפש השקפה חיזוק";
  assert.ok(suggestTags({ title: busy }, TAGS).length <= 5);
});

test("the most confident come first", () => {
  const suggested = suggestTags({ title: "פרשת ויחי וחשבון נפש" }, TAGS);
  assert.equal(suggested[0].name, "ויחי", "a name in the taxonomy beats a mapped subject");
});
