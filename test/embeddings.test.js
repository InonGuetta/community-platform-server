import "./setup.js";
import test from "node:test";
import assert from "node:assert/strict";
import { embeddingBatches, toVectorLiteral } from "../services/servicesEmbeddings.js";

// embedChunksForMedia writes its embeddings with UPDATE ... FROM unnest(), which
// hands Postgres two parallel arrays and joins them positionally. Everything
// rests on those arrays staying aligned: an off-by-one gives every chunk its
// neighbour's embedding, the UPDATE reports success, and semantic search returns
// the wrong passages from then on with nothing failing anywhere.
//
// It replaced one UPDATE per chunk — fine for a lecture's few dozen, minutes of
// pure waiting for a book's ~500.

const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, content: `c${i}` }));
// A recognisable vector per row: element 0 is the row's index.
const vectorsOf = (n) => Array.from({ length: n }, (_, i) => [i, 0.5]);

test("a vector literal is the pgvector text form", () => {
  assert.equal(toVectorLiteral([0.1, 0.2, 0.3]), "[0.1,0.2,0.3]");
});

test("each id is paired with its own vector, across batch boundaries", () => {
  const n = 250;
  const batches = embeddingBatches(rowsOf(n), vectorsOf(n), 100);

  // Flatten back out and check every pair, which is the property that matters —
  // not how the batches happened to be cut.
  const pairs = [];
  for (const [ids, literals] of batches) {
    assert.equal(ids.length, literals.length, "the two arrays must be the same length");
    ids.forEach((id, i) => pairs.push([id, literals[i]]));
  }

  assert.equal(pairs.length, n);
  pairs.forEach(([id, literal], i) => {
    assert.equal(id, 1000 + i, `row ${i} kept its id`);
    assert.equal(literal, toVectorLiteral([i, 0.5]), `row ${i} got ITS OWN vector`);
  });
});

test("batches are cut at the requested size", () => {
  assert.deepEqual(embeddingBatches(rowsOf(250), vectorsOf(250), 100).map(([ids]) => ids.length), [100, 100, 50]);
  // An exact multiple must not produce a trailing empty batch — that would send
  // a statement with two empty arrays for nothing.
  assert.deepEqual(embeddingBatches(rowsOf(200), vectorsOf(200), 100).map(([ids]) => ids.length), [100, 100]);
  assert.deepEqual(embeddingBatches(rowsOf(1), vectorsOf(1), 100).map(([ids]) => ids.length), [1]);
  assert.deepEqual(embeddingBatches([], [], 100), []);
});

// The arrays come from two different sources — a SELECT and an OpenAI response —
// so a length mismatch is possible in principle. Positional pairing would then
// silently produce `undefined` literals for the tail, which reaches Postgres as
// a cast error far from the cause.
test("a length mismatch is refused rather than half-written", () => {
  assert.throws(
    () => embeddingBatches(rowsOf(3), vectorsOf(2), 100),
    /3 rows but 2 vectors/
  );
});
