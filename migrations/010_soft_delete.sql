-- 010_soft_delete.sql
-- Adds the deleted_at column the app's soft-delete design already assumes.
-- getContacts / getCompanies / getDeals filter `.is('deleted_at', null)` and
-- deleteContact writes `deleted_at`, but the column was never added to the
-- deployed schema — so every list/dashboard query 400'd with
-- "column contacts.deleted_at does not exist" and returned nothing, even
-- though the rows exist. Idempotent; safe to re-run.
-- Applied to project kqimpzbphdogvchqmtos via Management API on 2026-07-30.

ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Partial indexes keep the common "live rows only" scans fast.
CREATE INDEX IF NOT EXISTS idx_contacts_live  ON contacts  (account_id, brand_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_live ON companies (account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_live     ON deals     (account_id) WHERE deleted_at IS NULL;
