-- 012_platform.sql
-- Phase D: platform / integration surface.
-- Items 14 (unified conversations), 18 (signed outbound webhooks),
-- 19 (data-driven automations engine). Item 15 (GHL location id) is code/config
-- only and needs no schema (stored in integration_connections.meta.locationId).
-- Item 20 (pgvector qualifier) is deferred. Safe after 004..011. Idempotent.

-- ===========================================================================
-- #14 Unified conversations — generalize inbox_messages into a channel-agnostic
-- thread model (email today; sms/social/whatsapp later). inbox_messages stays as
-- the email ingest source of truth; conversations mirror it plus outbound sends.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email',        -- email | sms | social | whatsapp
  external_thread_id TEXT,                       -- provider thread id (email thread_id, etc.)
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | closed | snoozed
  last_direction TEXT,                           -- inbound | outbound
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  unread_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- One thread per (account, channel, external_thread_id) when a thread id exists.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_thread_uidx
  ON conversations (account_id, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_account_idx ON conversations (account_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_contact_idx ON conversations (contact_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  direction TEXT NOT NULL DEFAULT 'inbound',      -- inbound | outbound
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body TEXT,
  external_id TEXT,                                -- provider message id (dedup)
  meta JSONB DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conv_messages_conv_idx ON conversation_messages (conversation_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS conv_messages_external_uidx
  ON conversation_messages (account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

-- Backfill: one conversation per (account, thread key) from existing inbox_messages,
-- then one conversation_message per inbox row. Thread key = thread_id, else contact,
-- else the message id itself (singleton thread). Idempotent via the unique indexes.
DO $$
DECLARE r RECORD; conv_id UUID; thread_key TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'inbox_messages') THEN
    FOR r IN SELECT * FROM inbox_messages ORDER BY received_at ASC LOOP
      thread_key := COALESCE(NULLIF(r.thread_id, ''), 'imsg:' || r.id::text);
      -- find-or-create the conversation for this thread key
      SELECT id INTO conv_id FROM conversations
        WHERE account_id = r.account_id AND channel = 'email' AND external_thread_id = thread_key
        LIMIT 1;
      IF conv_id IS NULL THEN
        INSERT INTO conversations (account_id, contact_id, channel, external_thread_id, subject,
                                   last_direction, last_message_at, unread_count)
        VALUES (r.account_id, r.contact_id, 'email', thread_key, r.subject,
                r.direction, r.received_at, CASE WHEN r.is_read THEN 0 ELSE 1 END)
        RETURNING id INTO conv_id;
      END IF;
      -- mirror the message (skip if already backfilled)
      IF NOT EXISTS (SELECT 1 FROM conversation_messages
                       WHERE account_id = r.account_id AND channel = 'email'
                         AND external_id = ('imsg:' || r.id::text)) THEN
        INSERT INTO conversation_messages (account_id, conversation_id, contact_id, channel, direction,
                                           from_addr, to_addr, subject, body, external_id, is_read, sent_at)
        VALUES (r.account_id, conv_id, r.contact_id, 'email', r.direction,
                r.from_addr, r.to_addr, r.subject, r.body, 'imsg:' || r.id::text, r.is_read, r.received_at);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ===========================================================================
-- #19 Automations engine (trigger / filter / action) — the product surface that
-- supersedes the hardcoded hermes trigger conditions. An automation fires on a
-- named trigger, evaluates a filter (JSON conditions) against the event context,
-- and runs an action. Runs are logged for observability.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger JSONB NOT NULL DEFAULT '{}'::jsonb,     -- { type, config }
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { match: 'all'|'any', conditions: [{field, op, value}] }
  action JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { type, config }
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  run_count INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automations_trigger_idx
  ON automations (account_id, (trigger->>'type')) WHERE is_active;

CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger_type TEXT,
  context JSONB DEFAULT '{}'::jsonb,
  matched BOOLEAN,
  outcome TEXT,                                    -- ran | skipped | error
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_runs_idx ON automation_runs (automation_id, created_at DESC);

-- ===========================================================================
-- #6 (cont.) Branch step config — Phase C stored `branch` as a no-op skip. The
-- rules engine now evaluates a step's `config` ({match, conditions[], jumpTo,
-- else}) to conditionally jump within a sequence. `config` also carries per-step
-- options for other step types going forward. Backward-compatible (default {}).
-- ===========================================================================
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

-- ===========================================================================
-- #18 Signed outbound webhooks — customer registers endpoints; platform emits
-- events to a durable delivery queue, drained by the tick with HMAC-signed POSTs
-- and bounded retries + exponential backoff.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,                            -- HMAC signing secret (shown once on create)
  events TEXT[] NOT NULL DEFAULT '{}',             -- subscribed event names; empty = all
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_status INT,
  last_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_account_idx ON webhook_endpoints (account_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | delivered | failed
  attempts INT NOT NULL DEFAULT 0,
  response_status INT,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  claim_id UUID,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');

-- Atomic claim for the delivery worker (mirrors claim_due_enrollments).
CREATE OR REPLACE FUNCTION claim_webhook_deliveries(
  p_limit INT,
  p_claim UUID,
  p_lock_seconds INT DEFAULT 120
) RETURNS SETOF webhook_deliveries AS $$
BEGIN
  RETURN QUERY
  UPDATE webhook_deliveries d
     SET claim_id = p_claim,
         locked_until = NOW() + (p_lock_seconds || ' seconds')::interval,
         attempts = d.attempts + 1
   WHERE d.id IN (
     SELECT id FROM webhook_deliveries
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY next_attempt_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING d.*;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- RLS parity with the rest of the schema (service-role bypasses; app scopes).
-- ===========================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','conversation_messages','automations',
                           'automation_runs','webhook_endpoints','webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
