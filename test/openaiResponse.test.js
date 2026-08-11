import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { completionText, completionJson } from "../lib/openaiClient.js";

// These two helpers exist because `response.choices[0].message.content` is a
// chain of three assumptions the API does not guarantee, and every one of them
// used to be made unguarded at six call sites. The failure that produced them
// was a `TypeError: Cannot read properties of null (reading 'trim')` raised an
// hour into a transcription, naming neither the stage nor the cause.
//
// So what is asserted here is mostly about the ERROR: that each malformed shape
// is rejected, that the message says which stage produced it, and that the
// model's own text never appears in it.

const ok = (content) => ({ choices: [{ message: { content }, finish_reason: "stop" }] });

const throwsWith = (fn, ...fragments) => {
  try {
    fn();
  } catch (err) {
    for (const fragment of fragments) {
      assert.ok(
        err.message.includes(fragment),
        `expected "${err.message}" to mention "${fragment}"`
      );
    }
    return err;
  }
  assert.fail("expected a throw");
};

test("a normal completion comes back trimmed", () => {
  assert.equal(completionText(ok("  hello  "), "ctx"), "hello");
});

// The API returns an empty array on some upstream failures. Indexing [0] on it
// gives undefined, and the old code then read .message off that.
test("no choices is an error, not a TypeError", () => {
  const err = throwsWith(() => completionText({ choices: [] }, "myStage"), "myStage", "no choices");
  assert.ok(!(err instanceof TypeError));
  throwsWith(() => completionText({}, "myStage"), "no choices");
  throwsWith(() => completionText(null, "myStage"), "no choices");
});

// content is null whenever the model refuses or the response is filtered — the
// single likeliest of these in practice, and the one that read as a null deref.
test("null or empty content is an error naming the stage and the finish_reason", () => {
  throwsWith(
    () => completionText({ choices: [{ message: { content: null }, finish_reason: "content_filter" }] }, "myStage"),
    "myStage", "no usable text", "content_filter"
  );
  // Whitespace-only counts as empty: `.trim()` on it produced "" and the caller
  // stored an empty summary as though it were real.
  throwsWith(() => completionText(ok("   "), "myStage"), "no usable text");
  // A response cut off by the token ceiling reports itself this way.
  throwsWith(
    () => completionText({ choices: [{ message: {}, finish_reason: "length" }] }, "myStage"),
    "length"
  );
});

test("valid JSON is parsed", () => {
  assert.deepEqual(completionJson(ok('{"summary":"s","key_points":["a"]}'), "ctx"), {
    summary: "s",
    key_points: ["a"],
  });
});

// json_object mode makes valid JSON very likely, not certain: a response cut off
// by the token limit ends mid-object and parses as nothing at all.
test("unparseable JSON says so instead of surfacing a bare SyntaxError", () => {
  throwsWith(() => completionJson(ok('{"summary": "cut off'), "myStage"), "myStage", "unparseable JSON");
});

// JSON.parse("null") succeeds and returns null; the caller then read .summary
// off it and was back to the same TypeError this was meant to remove.
test("JSON that is not an object is rejected", () => {
  throwsWith(() => completionJson(ok("null"), "myStage"), "not an object");
  throwsWith(() => completionJson(ok("42"), "myStage"), "not an object");
  throwsWith(() => completionJson(ok('"a string"'), "myStage"), "not an object");
});

// db/pool.js withholds query parameters because they hold transcript text. A
// completion IS transcript text — a summary of, or a correction to, one — so
// putting it in an error message would route around that rule. Length and
// finish_reason identify the failure without carrying any of it.
test("the model's text never appears in the error message", () => {
  const secret = "הרב אמר בשיעור על הלכות שבת";
  for (const call of [
    () => completionText(ok(""), "ctx"),
    () => completionJson(ok(`{oops ${secret}`), "ctx"),
    () => completionJson(ok(`"${secret}"`), "ctx"),
  ]) {
    try {
      call();
      assert.fail("expected a throw");
    } catch (err) {
      assert.ok(!err.message.includes(secret), `leaked content: ${err.message}`);
    }
  }
});
