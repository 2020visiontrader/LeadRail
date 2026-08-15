-- 024_personas.sql — Multi-persona agent roster, per account.
--
-- Today lib/agent/loop.ts runs a single fixed system prompt for every account
-- (LeadRail AI). This adds a real roster the agent loop can route to: named
-- personas with their own instructions (system-prompt fragment), tone, and an
-- optional model override that plugs into the A0 provider/model registry
-- (023_ai_providers.sql — ai_models.id). NULL model_id means "use the
-- account's ai_routing default", so a persona with no override behaves
-- exactly like the account default today.
--
-- One persona per account may be flagged the coordinator — when @mentions
-- resolve multiple personas, the coordinator's instructions frame the final
-- synthesized answer (see lib/agent/personas.ts). The partial unique index
-- enforces "at most one enabled coordinator per account" at the DB level, on
-- top of the application-level unset-other-coordinators logic in the API
-- routes — belt and suspenders, same as other single-row-per-account
-- invariants in this schema (ai_routing).
--
-- Scoping matches every other account-owned table: account_id UUID NOT NULL
-- REFERENCES accounts(id). RLS is enabled with no anon policies — service-role
-- bypasses, the app scopes every read/write by account_id in code (see
-- lib/http.ts requireSession + app/api/personas/*), consistent with
-- 019/022/023. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS personas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,                 -- e.g. "Strategist", "Closer"
  role           TEXT,                           -- short label shown in the roster, e.g. "Strategist"
  instructions   TEXT NOT NULL DEFAULT '',        -- persona system-prompt fragment
  model_id       UUID REFERENCES ai_models(id) ON DELETE SET NULL, -- NULL = account default routing (023)
  tone           TEXT,
  avatar         TEXT,
  is_coordinator BOOLEAN NOT NULL DEFAULT FALSE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personas_account ON personas(account_id, sort_order);

-- At most one ENABLED coordinator per account. A disabled coordinator row
-- doesn't count, so an account can freely keep old/disabled coordinator rows
-- around without tripping the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_one_coordinator
  ON personas(account_id)
  WHERE is_coordinator = TRUE AND enabled = TRUE;

-- RLS parity with the rest of the schema (service-role bypasses; the app
-- scopes all reads/writes by account_id — see app/api/personas/*).
ALTER TABLE personas ENABLE ROW LEVEL SECURITY;
