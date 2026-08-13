-- 028_approvals.sql — Durable approvals workflow for the agent's approval gate.
--
-- Today lib/agent/loop.ts's sensitive-tool gate is EPHEMERAL: runAgent/
-- runAgentStream return status 'needs_approval' with an in-memory
-- AgentProposal {tool,title,args,summary} + transcript, and the caller
-- resumes by calling runAgent again with input.approve={tool,args}. Nothing
-- is persisted — a proposal is lost if the tab closes, there's no actor
-- trail, no comments, no self-approval guard, no edit-invalidation.
--
-- This migration adds a persisted `approvals` row ADDITIVELY alongside that
-- flow (see lib/approvals/store.ts createApproval, called from loop.ts when a
-- proposal is emitted). It does NOT replace the in-memory transcript-resume
-- mechanism — args_encrypted here is a durable record of what was proposed
-- (for audit/actor-trail/edit-invalidation), not a new execution path.
--
-- Scoping/RLS convention matches 025_skills.sql / 026_mcp_clients.sql /
-- 027_scheduled_tasks.sql: account_id UUID NOT NULL. RLS enabled with no anon
-- policies — service-role bypasses, the app scopes every read/write by
-- account_id in code (see lib/approvals/store.ts, app/api/approvals/*).
-- args_encrypted is AES-256-GCM ciphertext via the existing vault
-- (lib/ai/crypto.ts encryptSecret/decryptSecret) — same pattern as
-- mcp_clients.auth_header_encrypted.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID,                                  -- nullable; not every proposal is tied to a persisted conversation today
  tool            TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  args_encrypted  TEXT,                                   -- AES-256-GCM ciphertext of the full proposed args (lib/ai/crypto.ts), for resume/audit
  args_redacted   JSONB NOT NULL DEFAULT '{}'::jsonb,      -- safe-to-display args (secret-ish keys redacted) — this is what the API/UI ever returns
  args_hash       TEXT NOT NULL,                           -- sha256 of canonical (sorted-key) JSON of the full args, for edit-invalidation
  state           TEXT NOT NULL DEFAULT 'pending',
  requested_by    TEXT,                                    -- actor email who triggered the proposal (session.email), or NULL if unknown
  decided_by      TEXT,                                    -- actor email who approved/rejected
  decided_at      TIMESTAMPTZ,
  comment         TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approvals_state_check CHECK (state IN ('pending','approved','rejected','expired','invalidated'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_account_state ON approvals(account_id, state);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
