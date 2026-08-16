-- 037_approval_execution.sql — Adds terminal 'executed' state to approvals, making
-- approval rows authoritative for execution.
--
-- 028 created `approvals` as an audit trail ALONGSIDE an ephemeral
-- transcript-resume flow in lib/agent/loop.ts that never consulted it — so a
-- rejected proposal could still execute if the same {tool,args} was resubmitted.
-- This migration adds the terminal 'executed' state that makes the row
-- AUTHORITATIVE for execution: consumeApprovalForExecution
-- (lib/approvals/store.ts) flips approved -> executed atomically, making an
-- approval single-use and closing the replay hole.
--
-- Idempotent; safe to re-run.

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_state_check;

ALTER TABLE approvals ADD CONSTRAINT approvals_state_check
  CHECK (state IN ('pending','approved','rejected','expired','invalidated','executed'));

ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_approvals_account_tool_hash ON approvals(account_id, tool, args_hash);
