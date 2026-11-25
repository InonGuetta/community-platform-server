import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { pool } from "../db/pool.js";
import { stubPoolQuery } from "./setup.js";
import { cleanDisplayName, GARBLED_CHAR } from "../services/servicesAuth.js";
import { findGarbledDisplayNames, repairGarbledDisplayName } from "../services/servicesUsers.js";

// UI_UX_FIXES 5.3. Account 9 was registered by curl from a Windows shell, whose
// code page is not UTF-8: the Hebrew name reached the JSON parser as invalid
// bytes, each became U+FFFD, and the users table showed a row of them. The name
// is now refused at the one function every door that takes a name goes through
// (registration, the profile edit, an admin's create and edit), and the rows
// already stored are repaired by scripts/fix-garbled-names.js.

test("the replacement character is U+FFFD", () => {
  assert.equal(GARBLED_CHAR, "�");
});

test("a display name holding a replacement character is refused, at registration and on an edit", () => {
  for (const required of [false, true]) {
    assert.throws(
      () => cleanDisplayName(`${GARBLED_CHAR}${GARBLED_CHAR}${GARBLED_CHAR} ${GARBLED_CHAR}${GARBLED_CHAR}`, { required }),
      { statusCode: 400, message: "Display name was not sent as UTF-8 text" }
    );
    assert.throws(() => cleanDisplayName(`משה ${GARBLED_CHAR}`, { required }), { statusCode: 400 });
  }
});

test("a name in any script, sent as UTF-8, is still a name", () => {
  for (const name of ["משתמש בדיקה להתראות", "Ruth Cohen", "רות כהן-לוי", "Иван"]) {
    assert.equal(cleanDisplayName(name, { required: true }), name);
  }
});

test("the repair finds by the mark, writes a clean name, and re-checks the mark", async () => {
  const stub = stubPoolQuery(pool, (text) => (/^\s*UPDATE/.test(text) ? { rows: [{ id: 9 }] } : { rows: [] }));
  try {
    await findGarbledDisplayNames();
    assert.equal(await repairGarbledDisplayName(9, "  משתמש בדיקה להתראות  "), true);
    const [find, repair] = stub.calls;
    assert.match(find.text, /STRPOS\(display_name, \$1\) > 0/);
    assert.deepEqual(find.params, [GARBLED_CHAR]);
    // A name somebody corrected by hand since the dry run no longer holds the
    // mark, and is left as they wrote it.
    assert.match(repair.text, /WHERE id = \$1 AND STRPOS\(display_name, \$3\) > 0/);
    assert.deepEqual(repair.params, [9, "משתמש בדיקה להתראות", GARBLED_CHAR]);
  } finally {
    stub.restore();
  }
});

test("the repair cannot write a garbled name of its own", async () => {
  const stub = stubPoolQuery(pool, () => {
    throw new Error("reached the database");
  });
  try {
    await assert.rejects(repairGarbledDisplayName(9, `x${GARBLED_CHAR}`), { statusCode: 400 });
  } finally {
    stub.restore();
  }
});
