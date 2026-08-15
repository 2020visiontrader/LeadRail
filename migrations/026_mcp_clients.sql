-- 026_mcp_clients.sql — External MCP server registry, per account.
--
-- Inverse of the existing MCP server (app/api/mcp/route.ts, where LeadRail IS
-- an MCP server exposing lib/agent/tools.ts). This table lets an account
-- REGISTER external MCP servers it wants to consume — the connect/test/list
-- registry only; wiring discovered tools into the agent loop is a later task
-- (see lib/mcp/client.ts header comment).
--
-- Scoping/RLS convention matches 023_ai_providers.sql / 025_skills.sql:
-- account_id UUID NOT NULL. auth_header is stored encrypted (AES-256-GCM,
-- lib/ai/crypto.ts — the same vault as ai_providers.api_key_encrypted); this
-- migration only defines the column, encryption happens in application code.
-- RLS enabled with no anon policies — service-role bypasses, the app scopes
-- every read/write by account_id in code (see app/api/mcp-clients/*).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS mcp_clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,                    -- operator-facing label, e.g. "Team Notion MCP"
  transport          TEXT NOT NULL,                     -- http | sse
  url                TEXT NOT NULL,                      -- server endpoint
  auth_header_encrypted TEXT,                            -- AES-256-GCM ciphertext of the Authorization header value; NULL for unauthenticated servers
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  last_status        TEXT,                               -- 'ok' | 'error' | NULL (never tested)
  last_checked_at    TIMESTAMPTZ,
  discovered_tools   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{ name, description }] snapshot from the last successful tools/list
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_clients_transport_check CHECK (transport IN ('http','sse')),
  CONSTRAINT mcp_clients_account_name_unique UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_mcp_clients_account ON mcp_clients(account_id);

ALTER TABLE mcp_clients ENABLE ROW LEVEL SECURITY;
