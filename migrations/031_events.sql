-- 031_events.sql — Lightweight event log, per account (Postgres-only CDP).
--
-- Every row is one tracked event (e.g. email_opened, page_viewed) optionally
-- tied to a contact, with a free-form JSONB `props` bag. No ClickHouse/Kafka —
-- this is deliberately simple; lib/analytics/store.ts aggregates with plain
-- SQL over this table (counts, timeseries).
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql / 029_journeys.sql / 030_segments.sql: account_id UUID
-- NOT NULL, RLS enabled with no anon policies — service-role bypasses, the
-- app scopes every read/write by account_id in code (see lib/analytics/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   UUID,
  type         TEXT NOT NULL,
  props        JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_account_created ON events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_account_type ON events(account_id, type);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
