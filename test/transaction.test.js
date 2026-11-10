import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import path from "path";
import { pool } from "../db/pool.js";
import { withTransaction } from "../db/transaction.js";
import { serverSourceFiles } from "./sourceFiles.js";

// db/transaction.js — the one place a transaction is opened. These drive it over
// a stand-in client: what it sends, what it answers, and that the client always
// goes back to the pool.

// A client that records statements and releases, and fails a statement on demand.
const fakeConnect = ({ failOn = null } = {}) => {
  const original = pool.connect;
  const statements = [];
  let releases = 0;
  pool.connect = async () => ({
    query: async (text) => {
      statements.push(text);
      if (failOn && failOn === text) throw new Error(`${text} failed`);
      return { rows: [] };
    },
    release: () => { releases += 1; },
  });
  return {
    statements,
    releases: () => releases,
    restore: () => { pool.connect = original; },
  };
};

test("a transaction that succeeds commits, answers with the work's value and releases", async () => {
  const db = fakeConnect();
  try {
    const value = await withTransaction(async (client) => {
      await client.query("SELECT 1");
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(db.statements, ["BEGIN", "SELECT 1", "COMMIT"]);
    assert.equal(db.releases(), 1);
  } finally {
    db.restore();
  }
});

test("a transaction whose work throws rolls back, rethrows that error and releases", async () => {
  const db = fakeConnect();
  const refusal = new Error("This request was already decided");
  try {
    await assert.rejects(
      withTransaction(async (client) => {
        await client.query("UPDATE x");
        throw refusal;
      }),
      (err) => err === refusal
    );
    assert.deepEqual(db.statements, ["BEGIN", "UPDATE x", "ROLLBACK"]);
    assert.equal(db.releases(), 1);
  } finally {
    db.restore();
  }
});

test("a ROLLBACK that fails does not replace the error that caused it", async () => {
  const db = fakeConnect({ failOn: "ROLLBACK" });
  const duplicate = Object.assign(new Error("duplicate key"), { code: "23505" });
  try {
    await assert.rejects(
      withTransaction(async () => { throw duplicate; }),
      (err) => err === duplicate
    );
    assert.equal(db.releases(), 1);
  } finally {
    db.restore();
  }
});

test("a COMMIT that fails is the error the caller sees, after a rollback", async () => {
  const db = fakeConnect({ failOn: "COMMIT" });
  try {
    await assert.rejects(withTransaction(async () => "done"), /COMMIT failed/);
    assert.deepEqual(db.statements, ["BEGIN", "COMMIT", "ROLLBACK"]);
    assert.equal(db.releases(), 1);
  } finally {
    db.restore();
  }
});

test("pool.connect is read on every call, so a stub installed after import is used", async () => {
  // What test/setup.js's stubPoolConnect and scripts/smoke.js both rely on.
  const db = fakeConnect();
  try {
    await withTransaction(async () => {});
    assert.deepEqual(db.statements, ["BEGIN", "COMMIT"]);
  } finally {
    db.restore();
  }
});

// ── One place opens a transaction ───────────────────────────────────────────
//
// scripts/smoke.js is the exception, and deliberately: it opens an OUTER
// transaction against the real database and runs the services inside it, so
// that nothing they write survives the check.
const OPENS_TRANSACTIONS = new Set([path.join("db", "transaction.js"), path.join("scripts", "smoke.js")]);

test("only db/transaction.js sends BEGIN", async () => {
  const files = await serverSourceFiles();
  assert.ok(files.length > 50, `only ${files.length} source files found`);
  const begins = files
    .filter(({ source }) => /query\(\s*["'`]BEGIN\b/.test(source))
    .map(({ file }) => file)
    .filter((file) => !OPENS_TRANSACTIONS.has(file));
  assert.deepEqual(begins, [], `BEGIN sent outside withTransaction in: ${begins.join(", ")}`);
});
