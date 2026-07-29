-- 009_outreach_hardening.sql
-- Phase A: outreach-engine correctness & deliverability.
-- Closes baseline gaps #1–#5: suppression, atomic claim, reply-stop,
-- open/click tracking, per-mailbox/account send caps. Idempotent.
-- Run after 001 -> 003 -> 002 -> 004 (and 005..008).

-- ---------------------------------------------------------------------------
-- #1 Suppression / blocklist (account-scoped). Enforced in every send path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,                                  -- exact address (lowercased) OR null when domain-level
  domain TEXT,                                 -- e.g. "example.com" — suppresses all addresses at the domain
  reason TEXT NOT NULL DEFAULT 'manual',       -- manual | unsubscribe | hard_bounce | complaint | spam
  source TEXT,                                 -- newsletter | sequence | webhook | import
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppressions_account_email
  ON suppressions(account_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppressions_account_domain
  ON suppressions(account_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_account ON suppressions(account_id);

-- ---------------------------------------------------------------------------
-- #3 Atomic enrollment claim + #2 reply-stop columns.
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS claim_id UUID;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS thread_id TEXT;         -- last outbound thread, for reply matching
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_enrollments_due
  ON sequence_enrollments(status, next_run_at) WHERE status = 'active';

-- Atomically claim up to p_limit due enrollments for one tick invocation.
-- FOR UPDATE SKIP LOCKED guarantees two concurrent ticks never grab the same
-- row (fixes gap #4 double-send). Claimed rows are stamped with claim_id and a
-- short lock window so a crashed tick self-heals when locked_until elapses.
CREATE OR REPLACE FUNCTION claim_due_enrollments(
  p_limit INT,
  p_claim UUID,
  p_lock_seconds INT DEFAULT 300
) RETURNS SETOF sequence_enrollments AS $$
BEGIN
  RETURN QUERY
  UPDATE sequence_enrollments e
     SET claim_id = p_claim,
         locked_until = NOW() + make_interval(secs => p_lock_seconds)
   WHERE e.id IN (
     SELECT id FROM sequence_enrollments
      WHERE status = 'active'
        AND next_run_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY next_run_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING e.*;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #4 Open/click tracking. Append-only events + per-step funnel counters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  step_id UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                          -- open | click
  url TEXT,                                    -- for click
  ua TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_events_contact ON email_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_events_enrollment ON email_events(enrollment_id);

ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS sent_count INT NOT NULL DEFAULT 0;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS open_count INT NOT NULL DEFAULT 0;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS click_count INT NOT NULL DEFAULT 0;

-- Atomic per-step counter bump (open_count | click_count | sent_count).
-- Column name is validated against an allowlist to avoid dynamic-SQL injection.
CREATE OR REPLACE FUNCTION increment_step_counter(p_step UUID, p_col TEXT)
RETURNS VOID AS $$
BEGIN
  IF p_col NOT IN ('sent_count', 'open_count', 'click_count') THEN
    RAISE EXCEPTION 'invalid counter column: %', p_col;
  END IF;
  EXECUTE format('UPDATE sequence_steps SET %I = %I + 1 WHERE id = $1', p_col, p_col)
    USING p_step;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #5 Deliverability caps. Per-mailbox daily cap + per-account daily cap.
-- ---------------------------------------------------------------------------
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS daily_cap INT NOT NULL DEFAULT 200;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sent_today INT NOT NULL DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS unlock_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_send_cap INT NOT NULL DEFAULT 500;

-- Count today's outbound sends for an account (through the contact join, since
-- email_campaigns predates the account_id column). Used to enforce daily caps.
CREATE OR REPLACE FUNCTION account_sent_today(p_account UUID) RETURNS INT AS $$
  SELECT COUNT(*)::INT
    FROM email_campaigns ec
    JOIN contacts c ON c.id = ec.contact_id
   WHERE c.account_id = p_account
     AND ec.status IN ('sent', 'opened', 'bounced')
     AND ec.sent_at >= date_trunc('day', NOW());
$$ LANGUAGE sql STABLE;

-- RLS on new tables (service-role bypasses; browsers cannot read).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppressions','email_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
