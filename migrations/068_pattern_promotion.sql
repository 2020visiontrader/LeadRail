-- 068_pattern_promotion.sql — provenance for a promoted pattern.
--
-- Tier 2 -> Tier 1 is the one memory transition a machine must not make on its
-- own. A wrong Tier 1 fact about one contact costs one relationship; a
-- wrongly-promoted pattern about "what works" steers budget and creative across
-- every future campaign until somebody notices. So a promotion needs a name and
-- a date on it, or "why does the system believe this" has no answer.
ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS promoted_by TEXT;
ALTER TABLE memory_edges ADD COLUMN IF NOT EXISTS promoted_at TIMESTAMPTZ;

COMMENT ON COLUMN memory_edges.promoted_by IS
  'Who approved this observation becoming something the system may act on. NULL on every tier-1 fact that was durable from the start.';
