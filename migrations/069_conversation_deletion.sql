-- 069_conversation_deletion.sql
-- agent_conversations had no deletion path at any layer: no DELETE handler on
-- either conversations route, no deleted_at column, no UI affordance. The only
-- thing that ever removed a conversation was deleting the whole account, via
-- FK cascade. A user could not delete a single chat.
--
-- This joins the soft-delete model already in place for contacts/companies/
-- deals/brands (migrations 010, 014): immediate disappearance from the user's
-- view via `deleted_at`, hard purge DEFAULT_GRACE_DAYS (30, lib/privacy.ts)
-- later via purge_soft_deleted(). No second pattern invented.

ALTER TABLE agent_conversations ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- Partial index for the common read: every list/load query filters
-- deleted_at IS NULL, same shape as idx_contacts_live / idx_companies_live /
-- idx_deals_live in migration 010.
CREATE INDEX IF NOT EXISTS idx_agent_conversations_live
  ON agent_conversations(account_id) WHERE deleted_at IS NULL;

-- CREATE OR REPLACE, not a new function: purge_soft_deleted (migration 016)
-- already runs from /api/hermes/tick and already purges contacts, companies,
-- deals, and brands. Those four DELETEs are carried over byte-for-byte —
-- only the agent_conversations DELETE is new — so this does not change
-- behaviour for the existing four tables, and the function's contract (an INT
-- total row count across every table it purges) is unchanged.
--
-- CAUTION, NOT FIXED HERE: /api/hermes/tick, the only caller of this function,
-- has never executed successfully in production (see BACKLOG.md §2 — no
-- scheduler exists yet: no wrangler.toml, no vercel.json, no GitHub Actions
-- cron, no pg_cron). So soft-deleted conversations will disappear from the
-- user's view immediately, exactly as intended, but will NOT actually be
-- hard-purged until that scheduler is wired up. That is a separate, already
-- tracked gap owned elsewhere — not addressed by this migration.
CREATE OR REPLACE FUNCTION purge_soft_deleted(p_days INT DEFAULT 30)
RETURNS INT AS $$
DECLARE
  cutoff TIMESTAMPTZ := NOW() - (p_days || ' days')::interval;
  n INT := 0; c INT;
BEGIN
  DELETE FROM contacts  WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM companies WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM deals     WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM brands    WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  DELETE FROM agent_conversations WHERE deleted_at IS NOT NULL AND deleted_at < cutoff;
  GET DIAGNOSTICS c = ROW_COUNT; n := n + c;
  RETURN n;
END;
$$ LANGUAGE plpgsql;
