import "./setup.js";
import test, { mock } from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { serverSourceFiles } from "./sourceFiles.js";
import { escapeLike } from "../lib/sqlLike.js";
import { escapeHtml } from "../lib/html.js";
import { withTimeout } from "../lib/timeout.js";
import { normalizeEmail } from "../lib/validate.js";

// Small helpers several modules share, and the guard that keeps each of them to
// one definition, in lib/ — a second copy is how two of them came to disagree.

test("escapeLike makes % and _ literal, escaping the backslash first", () => {
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("פרק_ב"), "פרק\\_ב");
  // The backslash is escaped too — otherwise one in the text would swallow the
  // character after it.
  assert.equal(escapeLike("a\\_"), "a\\\\\\_");
  assert.equal(escapeLike("שבת"), "שבת");
  assert.equal(escapeLike(42), "42");
});

test("escapeHtml escapes the five characters that can open markup", () => {
  assert.equal(escapeHtml(`<a href="x" title='y'>&</a>`), "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;");
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(7), "7");
});

test("normalizeEmail trims and lower-cases", () => {
  assert.equal(normalizeEmail("  Dana@Example.COM \n"), "dana@example.com");
});

test("withTimeout answers with the call's value when it is in time, and clears its timer", async () => {
  const cleared = mock.method(globalThis, "clearTimeout");
  try {
    assert.equal(await withTimeout(Promise.resolve("ok"), 1000), "ok");
    assert.equal(cleared.mock.callCount(), 1);
  } finally {
    cleared.mock.restore();
  }
});

test("withTimeout passes the call's own rejection through", async () => {
  await assert.rejects(withTimeout(Promise.reject(new Error("boom")), 1000), /boom/);
});

test("withTimeout rejects with the given message once the deadline passes", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withTimeout(never, 10, "queue did not respond in time"), {
    message: "queue did not respond in time",
  });
  await assert.rejects(withTimeout(never, 10), { message: "timeout" });
});

test("withTimeout accepts a plain value, as the health check passes the Redis client", async () => {
  const client = { status: "ready" };
  assert.equal(await withTimeout(client, 1000), client);
});

// ── One copy each ───────────────────────────────────────────────────────────

const HOMES = {
  escapeLike: path.join("lib", "sqlLike.js"),
  escapeHtml: path.join("lib", "html.js"),
  withTimeout: path.join("lib", "timeout.js"),
  normalizeEmail: path.join("lib", "validate.js"),
};

test("each shared helper is defined once, in its lib/ module", async () => {
  const files = await serverSourceFiles();
  // The walk found the tree, or the assertion below would pass over nothing.
  assert.ok(files.length > 50, `only ${files.length} source files found`);

  for (const [name, home] of Object.entries(HOMES)) {
    const pattern = new RegExp(`\\bconst ${name}\\s*=`);
    const definers = files.filter(({ source }) => pattern.test(source)).map(({ file }) => file);
    assert.deepEqual(definers, [home], `${name} is defined in ${definers.join(", ")}`);
  }
});
