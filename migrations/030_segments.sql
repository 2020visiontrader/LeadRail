-- 030_segments.sql — Dynamic contact segments, per account.
--
-- A segment is a saved, re-runnable filter over `contacts`: a name/description
-- plus a `filters` JSONB array of {field, op, value} triples. The whitelist of
-- allowed fields/ops lives in code (lib/segments/store.ts translateFilters) —
-- this table just stores the definition; it never stores raw SQL.
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql / 029_journeys.sql: account_id UUID NOT NULL, RLS enabled
-- with no anon policies — service-role bypasses, the app scopes every
-- read/write by account_id in code (see lib/segments/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  filters      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{field, op, value}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segments_account ON segments(account_id);

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;
