-- 027_scheduled_tasks.sql — Account-scoped recurring agent tasks.
--
-- Named intervals ONLY (hourly/daily/weekly) — no cron expression parsing.
-- Each row is a prompt the agent loop (lib/agent/loop.ts runAgent) runs on a
-- schedule; lib/scheduled/store.ts computes next_run_at with a trivial switch.
--
-- Scoping/RLS convention matches 025_skills.sql / 026_mcp_clients.sql:
-- account_id UUID NOT NULL. RLS enabled with no anon policies — service-role
-- bypasses, the app scopes every read/write by account_id in code (see
-- app/api/scheduled-tasks/*).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  interval       TEXT NOT NULL,                     -- hourly | daily | weekly
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at    TIMESTAMPTZ,
  next_run_at    TIMESTAMPTZ,
  last_status    TEXT,                               -- 'ok' | 'error' | NULL (never run)
  last_result    TEXT,                                -- truncated agent result/error summary
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scheduled_tasks_interval_check CHECK (interval IN ('hourly','daily','weekly'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_account ON scheduled_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(next_run_at) WHERE enabled = TRUE;

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;
