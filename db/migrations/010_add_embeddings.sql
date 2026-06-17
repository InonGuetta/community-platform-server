-- Semantic search support: pgvector embeddings on transcript_chunks.
-- Reuses the existing chunks (no re-chunk / no re-transcribe). The embeddings
-- are produced by OpenAI's text-embedding-3-small model → 1536 dimensions.
-- HNSW + cosine distance gives fast approximate nearest-neighbour search that
-- the hybrid query fuses with the existing FTS (007's GIN index) via RRF.
-- All statements are idempotent so re-running the migrator is a clean no-op.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE transcript_chunks ADD COLUMN IF NOT EXISTS embedding vector(1536);

-- HNSW needs pgvector >= 0.5 (available on Supabase). vector_cosine_ops matches
-- the `<=>` cosine-distance operator used by the semantic/hybrid queries.
CREATE INDEX IF NOT EXISTS idx_chunks_embedding ON transcript_chunks
  USING hnsw (embedding vector_cosine_ops);
