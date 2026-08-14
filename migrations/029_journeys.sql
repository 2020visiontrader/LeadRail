-- 029_journeys.sql — Visual journey / automation graph, per account.
--
-- The evolution of lib/sequences.ts (linear) into a branching DAG: a journey
-- is a named graph of nodes (trigger | send_email | wait | condition | goal |
-- exit) connected by edges. Nodes + edges live in the `graph` JSONB
-- (shape: { nodes: [{ id, type, config, next: [{ to, when? }] }] }).
-- `trigger` and `status` are denormalized for listing/activation.
--
-- Scoping/RLS convention matches 025/027/028/032: account_id UUID NOT NULL,
-- RLS enabled with no anon policies — service-role bypasses; the app scopes
-- every read/write by account_id in code (see lib/journeys/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS journeys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',              -- draft | active | paused | archived
  trigger      TEXT NOT NULL DEFAULT 'manual',             -- manual | lead_created | tag_added | stage_changed
  graph        JSONB NOT NULL DEFAULT '{"nodes":[]}'::jsonb,
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT journeys_status_check CHECK (status IN ('draft','active','paused','archived'))
);

CREATE INDEX IF NOT EXISTS idx_journeys_account ON journeys(account_id);
CREATE INDEX IF NOT EXISTS idx_journeys_account_status ON journeys(account_id, status);

ALTER TABLE journeys ENABLE ROW LEVEL SECURITY;
