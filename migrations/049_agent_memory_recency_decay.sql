-- 049_agent_memory_recency_decay.sql — Recency decay for semantic memory recall.
--
-- match_agent_memory() (migration 036) ranks purely by cosine similarity, with
-- no notion of time: an 18-month-old fact with a strong embedding match ranks
-- identically to one from yesterday. For a CRM whose facts describe a fast-
-- moving pipeline (deal stages, contact preferences, campaign performance),
-- that's wrong — stale-but-similar should lose to fresh-and-similar.
--
-- Adds exponential recency decay to the ranking: `decayed_similarity =
-- similarity * exp(-ln(2)/half_life_days * age_days)`, so a fact's effective
-- score halves every `half_life_days` (default 90 — long enough that a
-- correct fact from last quarter isn't discarded outright, short enough that
-- it stops out-competing fresher facts on tie-ish relevance). The 90-day
-- default is a judgment call, not a measured constant — tune p_half_life_days
-- per call if a shorter/longer memory window turns out to fit better.
--
-- `similarity` (raw, undecayed) is still returned alongside `decayed_similarity`
-- — callers that want the pure relevance floor (matching an actual meaning,
-- regardless of age) should keep filtering on `similarity`; only ORDER BY/LIMIT
-- (which facts make the cut) is decay-aware. This is a pure ranking change:
-- return shape is a superset of the migration-036 columns, so no application
-- code needs to change — lib/agent/memory.ts's semanticRecall() keeps working
-- unmodified, it just receives a different (recency-aware) top-N.
--
-- Idempotent; safe to re-run.

CREATE OR REPLACE FUNCTION match_agent_memory(
  p_account_id      UUID,
  p_query           vector(1024),
  p_limit           INT DEFAULT 8,
  p_half_life_days  REAL DEFAULT 90
)
RETURNS TABLE (id UUID, fact TEXT, similarity REAL, decayed_similarity REAL) AS $$
  SELECT
    m.id,
    m.fact,
    (1 - (m.embedding <=> p_query))::real AS similarity,
    (
      (1 - (m.embedding <=> p_query))
      * exp(
          (-ln(2) / GREATEST(p_half_life_days, 1))
          * GREATEST(EXTRACT(EPOCH FROM (now() - m.updated_at)) / 86400.0, 0)
        )
    )::real AS decayed_similarity
  FROM agent_memory m
  WHERE m.account_id = p_account_id
    AND m.embedding IS NOT NULL
  ORDER BY decayed_similarity DESC
  LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE sql STABLE;
