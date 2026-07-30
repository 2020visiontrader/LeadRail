-- 015_referrals.sql — ambassador / referral program.
-- Idempotent; safe to re-run. Applied to project kqimpzbphdogvchqmtos.
--
-- Model: one code per ambassador (vanity handle, unguessable UUID behind it).
--   - Link  leadrail.../r/<code>  -> first-party cookie + click log (online promo)
--   - Code  typed at signup                                (UGC / podcast / video)
-- Attribution: cookie window (default 60d); a code typed at signup OVERRIDES
-- last-click. Reward unlocks on a QUALIFYING event (verified/first-paid), not a
-- bare signup, and sits in a hold window before it becomes payable (fraud claw-back).
-- Double-sided: the referred friend AND the ambassador each get a reward.

CREATE TABLE IF NOT EXISTS referral_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_email TEXT,
  code TEXT NOT NULL,                              -- vanity handle (case-insensitive unique)
  kind TEXT NOT NULL DEFAULT 'ambassador',         -- ambassador | user
  reward_type TEXT NOT NULL DEFAULT 'credit',       -- credit | cash | discount
  reward_amount NUMERIC NOT NULL DEFAULT 25,        -- ambassador commission per qualified conversion
  friend_reward_type TEXT DEFAULT 'credit',
  friend_reward_amount NUMERIC DEFAULT 25,          -- what the referred friend gets
  hold_days INT NOT NULL DEFAULT 30,                -- claw-back window before payout
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS referral_codes_code_uidx ON referral_codes (LOWER(code));
CREATE INDEX IF NOT EXISTS referral_codes_account_idx ON referral_codes (account_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS referral_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID REFERENCES referral_codes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  ip_hash TEXT,                                    -- hashed, never raw PII
  ua_hash TEXT,
  referer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS referral_clicks_code_idx ON referral_clicks (code_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES referral_codes(id) ON DELETE CASCADE,
  referrer_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  referred_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL,
  referred_email TEXT,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | qualified | rewarded | rejected
  attributed_via TEXT,                             -- link | code
  qualified_at TIMESTAMPTZ,
  rewarded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
-- One attribution per referred account (last write wins on conflict; code overrides link in app logic).
CREATE UNIQUE INDEX IF NOT EXISTS referrals_referred_uidx ON referrals (referred_account_id) WHERE referred_account_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referrals_code_idx ON referrals (code_id, created_at DESC);
CREATE INDEX IF NOT EXISTS referrals_status_idx ON referrals (status);

-- Reward ledger — one row per beneficiary per qualified referral.
CREATE TABLE IF NOT EXISTS referral_rewards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id UUID REFERENCES referrals(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,   -- beneficiary
  beneficiary TEXT NOT NULL,                       -- ambassador | friend
  reward_type TEXT NOT NULL,                       -- credit | cash | discount
  amount NUMERIC NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'held',             -- held | payable | paid | void
  hold_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS referral_rewards_account_idx ON referral_rewards (account_id, status);
CREATE INDEX IF NOT EXISTS referral_rewards_due_idx ON referral_rewards (hold_until) WHERE status = 'held';

-- Who referred a given account (attribution record + anti-self-referral guard).
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referred_by_code    TEXT;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS referred_by_account UUID REFERENCES accounts(id) ON DELETE SET NULL;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['referral_codes','referral_clicks','referrals','referral_rewards'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
