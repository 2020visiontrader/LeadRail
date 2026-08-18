-- 044_mcp_client_allow_auto.sql — Packet 4: external MCP client bridge.
--
-- The plan of record (COPILOT_REMEDIATION_PLAN.md Phase 4) called for a new
-- `tools_cache JSONB` + `tools_cached_at TIMESTAMPTZ` pair. 026_mcp_clients.sql
-- already ships that exact cache under different names — `discovered_tools`
-- (JSONB, populated by the existing /test endpoint) and `last_checked_at`. This
-- migration deliberately does NOT duplicate them; lib/capabilities/external-mcp.ts
-- reads the existing columns.
--
-- What's actually missing is the per-client auto-run opt-in the plan also
-- calls for: "gate: external_send by default... unless the operator explicitly
-- marks that client's tools as safe (allow_auto BOOLEAN on the client row,
-- default FALSE)". A third party's side effects are unknown, so the default
-- must stay conservative (approval-required) until an operator opts a specific
-- client in.
--
-- Idempotent; safe to re-run.

ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS allow_auto BOOLEAN NOT NULL DEFAULT FALSE;
