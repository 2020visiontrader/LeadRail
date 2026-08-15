-- 036_agent_memory_embeddings.sql — Semantic recall for durable memory (B4).
--
-- Adds a pgvector embedding to agent_memory so the copilot can recall facts by
-- MEANING (nv-embedqa-e5-v5, 1024-dim), not just recency/keyword. Blended with
-- the existing recency digest in lib/agent/memory.ts; recall degrades to recency
-- when embeddings are absent, so this is a pure additive upgrade.
--
-- Tenancy: match_agent_memory() takes p_account_id and filters on it — the app
-- always passes the session accountId, never a client value. agent_memory has no
-- RLS (service-role + in-code account scoping), matching migration 022.
-- Idempotent; safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Approximate nearest-neighbor over cosine distance. HNSW needs no training step
-- (unlike ivfflat) and stays correct as rows are added incrementally.
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
  ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- Account-scoped semantic search. Returns the closest facts to p_query for one
-- account, nearest first, with a cosine similarity score in [0,1]. Rows without
-- an embedding are excluded (they still surface via the recency digest).
CREATE OR REPLACE FUNCTION match_agent_memory(
  p_account_id UUID,
  p_query      vector(1024),
  p_limit      INT DEFAULT 8
)
RETURNS TABLE (id UUID, fact TEXT, similarity REAL) AS $$
  SELECT m.id, m.fact, (1 - (m.embedding <=> p_query))::real AS similarity
  FROM agent_memory m
  WHERE m.account_id = p_account_id
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> p_query
  LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE sql STABLE;
