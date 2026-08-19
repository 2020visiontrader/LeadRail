-- 048_brand_goals.sql — cross-session marketing goals.
--
-- Every capability before this is single-turn: ask, get an artefact, done. A
-- goal is the opposite — an objective that OUTLIVES the conversation and keeps
-- being worked until a gate says the floor was met (the kai-goal pattern).
--
-- The distinction that makes it work: `objective` is what the operator wants,
-- `success_criterion` is how anyone can tell it happened. A goal without a
-- checkable criterion is a wish, and the loop would never terminate.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS brand_goals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id          TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  objective         TEXT NOT NULL,
  -- Written at creation, never by the thing doing the work. Same separation of
  -- powers as the content gate: the actor may not move its own goalposts.
  success_criterion TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'paused', 'met', 'abandoned')),
  -- Append-only narrative of what has been tried. This is the memory that lets a
  -- later session continue rather than restart.
  progress_log      JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_worked_at    TIMESTAMPTZ,
  met_at            TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brand_goals_active
  ON brand_goals(account_id, status, last_worked_at NULLS FIRST)
  WHERE status = 'active';

ALTER TABLE brand_goals ENABLE ROW LEVEL SECURITY;
