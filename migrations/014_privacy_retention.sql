-- 014_privacy_retention.sql
-- Data protection: account deletion (soft -> grace window -> hard purge),
-- venture (brand) soft-delete parity, and a durable privacy audit trail.
-- Idempotent; safe to re-run. Applied to project kqimpzbphdogvchqmtos.
--
-- Deletion model (industry-standard soft-delete):
--   1. Owner requests deletion -> accounts.deletion_scheduled_for = now + grace.
--   2. During the grace window the account still works and can CANCEL.
--   3. A daily purge job hard-deletes accounts past their scheduled date.
--      accounts(id) cascades to every tenant-scoped table via FK ON DELETE
--      CASCADE, so the purge is provably total at the DB layer; storage objects
--      under <account_id>/ are removed by the job before the row is deleted.

-- ---------------------------------------------------------------------------
-- Account-level soft delete + retention window.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deletion_requested_at  timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deletion_reason        text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS deleted_at             timestamptz;

CREATE INDEX IF NOT EXISTS idx_accounts_purge_due
  ON accounts (deletion_scheduled_for)
  WHERE deletion_scheduled_for IS NOT NULL AND deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Venture (brand) soft delete, mirroring contacts/companies/deals.
-- ---------------------------------------------------------------------------
ALTER TABLE brands ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_brands_live ON brands (account_id) WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- Privacy audit trail. References accounts ON DELETE SET NULL so the record of
-- a deletion SURVIVES the purge — that surviving proof is what compliance
-- ("we can demonstrate the data was erased") actually requires.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS privacy_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,   -- account_deletion_requested | account_deletion_canceled
                          -- | account_purged | data_exported | venture_deleted | contact_deleted
  target TEXT,
  detail JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS privacy_events_account_idx ON privacy_events (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS privacy_events_action_idx  ON privacy_events (action, created_at DESC);

ALTER TABLE privacy_events ENABLE ROW LEVEL SECURITY;
