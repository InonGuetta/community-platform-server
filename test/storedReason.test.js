import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { badRequest, storedReason, parseStoredReason, ERROR_CODES } from "../lib/AppError.js";
import { errorHandler } from "../middleware/errorHandler.js";

// A permanent failure's reason is stored as a code and its facts, never a
// sentence: the row is read later, by people reading the site in different
// languages (client utilities/processingReason.js words it).

test("a reason is stored as its code and params, and read back", () => {
  const err = badRequest("Too little text", ERROR_CODES.DOCUMENT_TOO_SHORT, { words: 12, min: 50 });
  const stored = storedReason(err);
  assert.deepEqual(JSON.parse(stored), { code: "DOCUMENT_TOO_SHORT", params: { words: 12, min: 50 } });
  assert.deepEqual(parseStoredReason(stored), { code: "DOCUMENT_TOO_SHORT", params: { words: 12, min: 50 } });
});

test("no code, nothing stored; an older row's sentence comes back as text", () => {
  assert.equal(storedReason(new Error("boom")), null);
  assert.equal(parseStoredReason(null), null);
  assert.deepEqual(parseStoredReason("לא נמצא טקסט קריא בקובץ."), { text: "לא נמצא טקסט קריא בקובץ." });
});

test("the error handler sends an AppError's params with its code", () => {
  let body;
  const res = { headersSent: false, status: () => res, json: (b) => { body = b; return res; } };
  errorHandler(badRequest("At most 20 tags", ERROR_CODES.TAG_LIMIT, { max: 20 }), { method: "PUT", path: "/x" }, res, () => {});
  assert.deepEqual(body, { message: "At most 20 tags", code: "TAG_LIMIT", params: { max: 20 } });

  errorHandler(badRequest("Bad"), { method: "PUT", path: "/x" }, res, () => {});
  assert.equal("params" in body, false);
});
