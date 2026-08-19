-- 047_brand_strategies.sql — persisted marketing strategies per brand.
--
-- analyzeBrand generated a plan and threw it away: the operator had to keep it
-- in chat scrollback, and nothing downstream (campaigns, content, a future goal
-- loop) could reference "the strategy we agreed".
--
-- History is kept rather than overwritten. A strategy is a decision, and seeing
-- what changed once the brand profile improved is the point of keeping it.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS brand_strategies (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id    TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  -- The operator's stated goal for this run, when given. Two strategies for the
  -- same brand under different goals are both legitimate.
  goal        TEXT,
  -- Full structured strategy from analyzeBrand. jsonb so the shape can evolve
  -- without a migration; the capability is the schema authority.
  strategy    JSONB NOT NULL,
  -- Which model tier produced it, for when quality varies across the ladder.
  model_tier  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_strategies_brand
  ON brand_strategies(account_id, brand_id, created_at DESC);

ALTER TABLE brand_strategies ENABLE ROW LEVEL SECURITY;
