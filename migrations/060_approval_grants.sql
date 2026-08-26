-- "Allow for this chat" — a bounded standing approval.
--
-- Approving each reveal one at a time is not a meaningful control, it is a
-- reflex. A person clicking the twentieth identical card is not reading it, and
-- a gate nobody reads has stopped being a gate — so the single-use-only design
-- was buying less safety than it looked like it was.
--
-- The answer is not an unlimited toggle. A grant that never runs out, never
-- expires and covers the whole account is a blank cheque on a capability that
-- spends money, which is the exact thing the gate exists to prevent. So a grant
-- is bounded three ways, and every bound is load-bearing:
--
--   conversation_id  the work it was granted for, not everything the account
--                    ever does. "Yes, reveal these leads" must not license a
--                    reveal in a chat opened next week.
--   uses_remaining   finite and visible. The person authorised an amount of
--                    work, not an open tap.
--   expires_at       a grant forgotten about stops applying on its own.
--
-- Every execution under a grant still writes an approvals row (state
-- 'executed', requested_by 'grant:<id>'), so the audit trail records what
-- happened and under whose authority. An auto-approved action that leaves no
-- trace is the failure mode this whole subsystem exists to avoid.

CREATE TABLE IF NOT EXISTS approval_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  -- NULL would mean account-wide, which is deliberately not offered: every
  -- grant belongs to the conversation whose work it was granted for.
  conversation_id UUID NOT NULL,
  tool TEXT NOT NULL,
  granted_by TEXT,
  uses_remaining INT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT approval_grants_uses_check CHECK (uses_remaining >= 0)
);

-- The lookup on every sensitive call: this account, this chat, this tool.
CREATE INDEX IF NOT EXISTS approval_grants_lookup
  ON approval_grants(account_id, conversation_id, tool);

ALTER TABLE approval_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.approval_grants FROM anon, authenticated;
