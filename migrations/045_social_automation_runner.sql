-- 045_social_automation_runner.sql — Packet 7.3: the automation runner.
--
-- migration 040 created social_automations as an inert row: enabled defaults
-- false, daily_cap is DB-CHECKed, and nothing consumed sends_today /
-- last_reset_at. This migration adds the three pieces of DB-side machinery
-- the runner (lib/social/automation-runner.ts) needs to fire safely:
--
--   1. claim_social_automation_send() — the cap enforcement itself. Mirrors
--      claim_due_enrollments() in 009_outreach_hardening.sql: a single
--      SELECT ... FOR UPDATE inside one plpgsql function call is one
--      transaction, so the row lock serializes two concurrent webhook
--      deliveries racing to send under the same rule — the second call
--      blocks until the first's UPDATE commits, then re-reads the
--      now-current sends_today. No app-level check-then-write gap exists.
--   2. social_automation_events — idempotency. A UNIQUE (automation_id,
--      external_event_id) index means a webhook redelivering the same
--      comment/message id a second time hits a unique-violation on insert,
--      which the runner treats as "already processed" and skips. This is
--      the ONLY place double-send protection lives; the cap claim alone
--      would still fire twice for the same event if it arrived twice under
--      the cap.
--   3. accounts.social_automations_paused — the kill switch. One flag that
--      short-circuits every rule for the account at once, checked before any
--      rule lookup. Turning rules on/off individually stays a separate lever
--      (lib/capabilities/social-automations.ts enable/disable); this is the
--      "stop everything right now" switch on top of that.
--
-- Idempotent; safe to re-run.

-- ---------------------------------------------------------------------------
-- 1) Atomic cap claim.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_social_automation_send(p_automation_id UUID)
RETURNS TABLE(claimed BOOLEAN, remaining INT) AS $$
DECLARE
  v_cap INT;
  v_sends INT;
  v_last_reset DATE;
BEGIN
  -- Row lock held for the rest of this function call — concurrent callers
  -- for the SAME rule serialize here instead of both reading a stale count.
  SELECT daily_cap, sends_today, last_reset_at
    INTO v_cap, v_sends, v_last_reset
    FROM social_automations
   WHERE id = p_automation_id
     AND enabled = true               -- disabled rules never claim a send
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  -- Reset on date rollover, same convention as account_sent_today elsewhere.
  IF v_last_reset IS DISTINCT FROM CURRENT_DATE THEN
    v_sends := 0;
  END IF;

  IF v_sends >= v_cap THEN
    -- Still persist the reset so the counter doesn't carry a stale prior-day
    -- value forward once the day actually rolls over for real.
    UPDATE social_automations
       SET last_reset_at = CURRENT_DATE
     WHERE id = p_automation_id;
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  UPDATE social_automations
     SET sends_today = v_sends + 1,
         last_reset_at = CURRENT_DATE,
         updated_at = NOW()
   WHERE id = p_automation_id;

  RETURN QUERY SELECT true, (v_cap - v_sends - 1);
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- 2) Idempotency — one row per (rule, inbound event) ever processed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS social_automation_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id      UUID NOT NULL REFERENCES social_automations(id) ON DELETE CASCADE,
  external_event_id  TEXT NOT NULL,          -- platform comment/message id
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_social_automation_events
  ON social_automation_events(automation_id, external_event_id);
CREATE INDEX IF NOT EXISTS idx_social_automation_events_account
  ON social_automation_events(account_id);

ALTER TABLE social_automation_events ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 3) Account-level kill switch.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS social_automations_paused BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 4) Social-identity suppression. suppressions (009_outreach_hardening.sql)
--    is email/domain-only; social_automations acts on platform identities
--    (an Instagram commenter id) that never carry an email in the webhook
--    payload. These columns extend the SAME table (same enforcement point,
--    same audit surface) rather than forking a parallel suppression concept.
-- ---------------------------------------------------------------------------
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS platform TEXT;
ALTER TABLE suppressions ADD COLUMN IF NOT EXISTS external_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppressions_account_platform_external
  ON suppressions(account_id, platform, external_id) WHERE platform IS NOT NULL AND external_id IS NOT NULL;
