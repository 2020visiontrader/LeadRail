-- 032_content_pipeline.sql — Account-scoped content-creation pipeline runs.
--
-- Implements the "Scout -> Planner -> Creator -> Reviewer -> Publisher ->
-- Analyst" content pipeline (socialflow-style). Each row is ONE run of the
-- pipeline for a given topic. The six stages are stored as an ordered JSONB
-- array in `stages` (each entry: key, status, output, error, timestamps);
-- `status`/`current_stage` are denormalized for fast listing, and `output`
-- holds the final assembled result (analyst summary) or a failure record.
-- The orchestrator that walks the stages lives in lib/pipeline/store.ts.
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql: account_id UUID NOT NULL, RLS enabled with no anon
-- policies — service-role bypasses, the app scopes every read/write by
-- account_id in code (see lib/pipeline/store.ts, app/api/pipeline/*).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS content_pipeline_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',          -- running | completed | failed
  current_stage TEXT,                                     -- scout | planner | creator | reviewer | publisher | analyst
  stages        JSONB NOT NULL DEFAULT '[]'::jsonb,       -- ordered array of stage results
  output        JSONB,                                    -- final assembled result, or failure record
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_pipeline_runs_status_check CHECK (status IN ('running','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_content_pipeline_runs_account ON content_pipeline_runs(account_id);
CREATE INDEX IF NOT EXISTS idx_content_pipeline_runs_created ON content_pipeline_runs(created_at DESC);

ALTER TABLE content_pipeline_runs ENABLE ROW LEVEL SECURITY;
