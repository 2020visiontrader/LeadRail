-- 017_credits.sql — AI-credit wallet + referral credit rewards.
-- Referral rewards are paid in AI CREDITS ONLY (never cash). An ambassador earns
-- a percentage (default 10%) of the referred plan's monthly credit allocation,
-- applied as a top-up to their credit balance after the hold window clears.
-- Idempotent. Applied to project kqimpzbphdogvchqmtos.

-- Per-account AI-credit wallet.
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS credit_balance INTEGER NOT NULL DEFAULT 0;

-- Immutable ledger — every credit change is a row (audit + reconciliation).
CREATE TABLE IF NOT EXISTS credit_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,                 -- + grant, - spend
  reason TEXT NOT NULL,                    -- referral_reward | referral_welcome | signup | manual | spend
  ref_id UUID,                             -- e.g. referral_id
  balance_after INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS credit_tx_account_idx ON credit_transactions (account_id, created_at DESC);
ALTER TABLE credit_transactions ENABLE ROW LEVEL SECURITY;

-- Atomic credit application. Increments the balance and writes the ledger row in
-- one statement so concurrent grants can't race or lose updates. Returns the new
-- balance. SECURITY: callers pass a server-derived account_id only.
CREATE OR REPLACE FUNCTION apply_credits(
  p_account UUID, p_delta INT, p_reason TEXT, p_ref UUID DEFAULT NULL
) RETURNS INTEGER AS $$
DECLARE new_balance INTEGER;
BEGIN
  UPDATE accounts SET credit_balance = credit_balance + p_delta
   WHERE id = p_account
   RETURNING credit_balance INTO new_balance;
  IF new_balance IS NULL THEN RETURN NULL; END IF;  -- unknown account: no-op
  INSERT INTO credit_transactions (account_id, delta, reason, ref_id, balance_after)
  VALUES (p_account, p_delta, p_reason, p_ref, new_balance);
  RETURN new_balance;
END;
$$ LANGUAGE plpgsql;

-- Referral reward is a PERCENTAGE of the referred plan's credits, not a flat amount.
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS reward_percent        NUMERIC NOT NULL DEFAULT 10;
ALTER TABLE referral_codes ADD COLUMN IF NOT EXISTS friend_reward_percent NUMERIC NOT NULL DEFAULT 10;
-- Rewards are always credits now.
UPDATE referral_codes SET reward_type = 'credit', friend_reward_type = 'credit';
ALTER TABLE referral_codes ALTER COLUMN reward_type SET DEFAULT 'credit';

-- A settled reward is 'applied' (credits added to balance). Existing statuses
-- (held/payable/paid/void) still valid; 'applied' is the terminal credit state.
