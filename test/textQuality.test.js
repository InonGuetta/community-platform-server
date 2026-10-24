import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "fs/promises";
import { textQuality, wordShare, LOW_TEXT_QUALITY } from "../lib/textQuality.js";

// How much of a book's extracted text reads (migration 033). The samples are
// the real thing: the good one is how a Whisper transcript reads, the broken
// ones are lifted from the text layer of the first sefer in the archive, whose
// OCR read across its columns.

const GOOD = "היהודי מבני ברק נסע לבירת תימן, צאנה, שהיא מעוז החוסין. הוא יצא לשוק המקומי, פגש את האנשים, וביקר בבית ספר שבו ראה ספרים רבים. בסוף הניח תפילין בצאנה, ואמר שזה היה רגע מיוחד.";
const BROKEN = "ה פ ט ר ת מ ח ר ת ד ש מל ק ט נ ע ר ןדז 1 נ תן את־החיצי החצים יר ד ^?זמי את לא־ צרתע'לךבר ’ ואשר ידברבעןם ■ ’ יתפרע ארי .גלי מ^כןד 1 הי ר?";

const repeat = (s, n) => Array.from({ length: n }, () => s).join(" ");

test("a transcript reads as readable", () => {
  assert.ok(wordShare(GOOD) > 0.9, `share was ${wordShare(GOOD)}`);
  assert.equal(textQuality(repeat(GOOD, 40)), 100);
});

test("OCR read across columns reads as broken", () => {
  assert.ok(wordShare(BROKEN) < 0.6, `share was ${wordShare(BROKEN)}`);
  assert.equal(textQuality(repeat(BROKEN, 40)), 0);
});

test("a book that is part good, part broken scores the share that reads", () => {
  // Windows of 200 words: a long good stretch, then a long broken one.
  const book = `${repeat(GOOD, 60)} ${repeat(BROKEN, 60)}`;
  const quality = textQuality(book);
  assert.ok(quality > 30 && quality < 70, `quality was ${quality}`);
  assert.ok(quality < LOW_TEXT_QUALITY, "and that is low enough to warn about");
});

test("abbreviations and punctuation are words, not noise", () => {
  assert.ok(wordShare('כתב הרמב"ם בהל׳ תפילין: "וקשרתם לאות על ידך" (דברים ו, ח).') > 0.8);
});

test("no text is not 'zero percent readable' — it is not measured", () => {
  assert.equal(textQuality(""), null);
  assert.equal(textQuality("   \n "), null);
});

test("the client warns at the same threshold the server measures against", async () => {
  const source = await readFile(new URL("../../community-platform-client/src/utilities/constant.js", import.meta.url), "utf8");
  const match = /export const LOW_TEXT_QUALITY = (\d+);/.exec(source);
  assert.ok(match, "the client's LOW_TEXT_QUALITY was not found — moved or renamed?");
  assert.equal(Number(match[1]), LOW_TEXT_QUALITY);
});
