-- 033_budgets.sql — Per-account spend budgets / credit caps.
--
-- One row per account: an optional monthly credit limit, an alert threshold
-- (%), and an optional hard-stop switch. `enabled=false` by default so this
-- is entirely opt-in — with no row (or enabled=false), spend is unaffected.
-- lib/budgets/store.ts computes `spent` on the fly from credit_transactions
-- (no running counter to keep in sync).
--
-- Scoping/RLS convention matches 030_segments.sql / 031_events.sql:
-- account_id UUID NOT NULL, RLS enabled with no anon policies — service-role
-- bypasses, the app scopes every read/write by account_id in code.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS account_budgets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  monthly_limit_credits INTEGER,
  alert_threshold_pct   INTEGER NOT NULL DEFAULT 80,
  hard_stop             BOOLEAN NOT NULL DEFAULT FALSE,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_budgets_account ON account_budgets(account_id);

ALTER TABLE account_budgets ENABLE ROW LEVEL SECURITY;
