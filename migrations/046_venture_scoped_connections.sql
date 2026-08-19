-- 046_venture_scoped_connections.sql — per-venture integration identities.
--
-- integration_connections was account-scoped only, so a venture could not have
-- its own Resend account (or any other provider identity). The workaround was a
-- hardcoded brandId -> env-var map in lib/integrations/resend.ts, which meant
-- onboarding a venture's own sending domain required a code edit AND a redeploy.
-- That is the opposite of "plug in any brand and run it".
--
-- brand_id is NULLABLE and NULL means account-wide — every existing row keeps
-- its exact current meaning and today's behaviour is unchanged. A row WITH a
-- brand_id is venture-specific and takes precedence for that venture only.
--
-- DELIBERATELY NO uniqueness on (account_id, provider): multiple connections per
-- provider are legitimate and already present — an account can have several
-- Facebook Pages or Instagram accounts, distinguished by external_id. A first
-- draft of this migration added that constraint and Postgres refused it with a
-- real duplicate, which was the right answer.
--
-- Idempotent; safe to re-run.

ALTER TABLE integration_connections ADD COLUMN IF NOT EXISTS brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE;

-- Lookup path is (account, brand, provider) on every send, so index it.
CREATE INDEX IF NOT EXISTS idx_integration_connections_brand
  ON integration_connections(account_id, brand_id, provider)
  WHERE brand_id IS NOT NULL;
