-- 039_mcp_keys.sql — Per-account API keys for LeadRail's own MCP server.
--
-- app/api/mcp/route.ts authenticates every caller with ONE shared static
-- APP_API_SECRET and resolves the account from the MCP_ACCOUNT_ID env var, then
-- invokes runTool directly with no sensitivity check — so any holder of that
-- single secret could call launchCampaign / sendEmail / sourceLeads (real ad
-- spend, real emails, real credits) with no approval and no audit trail. That
-- is the remaining bypass around the approval gate that 037/028 built for the
-- in-app agent.
--
-- This table makes MCP callers first-class, per-account principals: a bearer
-- token maps to exactly one account, and sensitive tools require an explicit
-- per-key opt-in (allow_sensitive). The bearer token itself is NEVER stored —
-- only its sha256 (key_hash), which is what the route looks up. Revocation is
-- a timestamp, not a delete, so the audit trail survives.
--
-- Scoping/RLS convention matches 026_mcp_clients.sql / 028_approvals.sql:
-- account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, RLS
-- enabled with no anon policies — service-role bypasses, the app scopes every
-- read/write by account_id in code (see lib/mcp/keys.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,                       -- operator-facing name, e.g. "Claude Desktop (laptop)"
  key_hash        TEXT NOT NULL UNIQUE,                -- sha256 hex of the bearer token; the token itself is never stored
  allow_sensitive BOOLEAN NOT NULL DEFAULT FALSE,      -- opt-in for spend/external-send/destructive tools; default DENY
  last_used_at    TIMESTAMPTZ,                          -- best-effort touch on each resolve; never blocks a request
  revoked_at      TIMESTAMPTZ,                          -- soft revoke — a non-NULL value denies the key, row kept for audit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The route's only lookup is by key_hash on every request, so index it. (The
-- UNIQUE constraint already implies an index; this is explicit and idempotent
-- per the plan, and harmless if the constraint's index is used instead.)
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_key_hash ON mcp_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_account ON mcp_api_keys(account_id);

ALTER TABLE mcp_api_keys ENABLE ROW LEVEL SECURITY;
