-- 062_approval_grants.sql — the "approve for this session" tier.
--
-- THE PROBLEM, FROM PRODUCTION DATA
--
-- approvals in this account, by tool:
--     enrichLead    29   (25 executed, 3 expired, 1 approved)
--     sourceLeads   10
--
-- sourceLeads is ONE call capped at 25 candidates. enrichLead is PER LEAD, and
-- it carries the `spend` gate — so revealing a pool of 50 leads means 50
-- separate approval cards for a decision the operator already made once, out
-- loud, when they said "pull fifty". Three of those cards lapsed unanswered,
-- which is what approval fatigue looks like in the data.
--
-- The existing gate has two answers: approve this one call, or reject it. This
-- adds the third: approve this TOOL, for THIS conversation, up to N uses.
--
-- THE TABLE ALREADY EXISTED — and that is why this migration is written with
-- IF NOT EXISTS throughout. `approval_grants` was created directly against
-- production at some point with zero rows and zero code references anywhere in
-- the repo, and it never appeared in migrations/. Its columns were already
-- right. This brings it under version control and gives it a reader.

CREATE TABLE IF NOT EXISTS approval_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- SESSION SCOPE. NOT NULL is the whole safety story: a grant cannot outlive
  -- the conversation it was given in, so the next session asks again. That is
  -- the behaviour the operator asked for, not a limitation of it.
  conversation_id UUID NOT NULL,
  -- Per TOOL, never blanket. Approving enrichLead for a session says nothing
  -- about sendEmail.
  tool            TEXT NOT NULL,
  granted_by      TEXT,
  -- Bounded. "Approve 50" means fifty, not "until I notice". A grant that can
  -- be exhausted is a grant whose blast radius the operator chose.
  uses_remaining  INT NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The lookup on every sensitive call: is there a live grant for this tool in
-- this conversation? Partial, so the index only carries usable grants.
CREATE INDEX IF NOT EXISTS idx_approval_grants_live
  ON approval_grants(account_id, conversation_id, tool)
  WHERE revoked_at IS NULL AND uses_remaining > 0;

CREATE INDEX IF NOT EXISTS idx_approval_grants_account
  ON approval_grants(account_id, created_at DESC);

-- Audit link: an action that ran under a grant still writes an approvals row,
-- so the ledger stays complete. Without this, using a grant would make actions
-- DISAPPEAR from the audit trail — the opposite of what a standing permission
-- should do, since it is the case most worth being able to review afterwards.
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS grant_id UUID REFERENCES approval_grants(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_grant ON approvals(grant_id) WHERE grant_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Atomic consumption.
--
-- Read-then-write in application code would let two concurrent tool calls both
-- read uses_remaining = 1 and both proceed — spending twice against a budget
-- of one. This does the find-and-decrement in a single statement.
--
-- FOR UPDATE SKIP LOCKED: if another transaction holds the newest matching
-- grant, take the next one rather than blocking a live turn on a row lock.
--
-- Returns the REMAINING count after decrementing, or NULL when no live grant
-- applied — which the caller reads as "fall through to the normal approval
-- card". Returning 0 is meaningful and distinct from NULL: it means this call
-- was the last one the grant covered.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION consume_approval_grant(
  p_account      UUID,
  p_conversation UUID,
  p_tool         TEXT
) RETURNS TABLE (grant_id UUID, uses_left INT)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  UPDATE approval_grants g
     SET uses_remaining = g.uses_remaining - 1,
         updated_at     = NOW()
   WHERE g.id = (
     SELECT s.id
       FROM approval_grants s
      WHERE s.account_id      = p_account
        AND s.conversation_id = p_conversation
        AND s.tool            = p_tool
        AND s.revoked_at IS NULL
        AND s.expires_at > NOW()
        AND s.uses_remaining > 0
      ORDER BY s.created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED
   )
  RETURNING g.id, g.uses_remaining;
END;
$$;

COMMENT ON TABLE approval_grants IS
  'Session-scoped, per-tool, use-capped standing approval. The third tier beside approve-once and reject. Never outlives its conversation.';
COMMENT ON FUNCTION consume_approval_grant IS
  'Atomically claim one use of a live grant. Returns the grant id and remaining uses, or no row when none applies.';

ALTER TABLE approval_grants ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.approval_grants FROM anon, authenticated;
