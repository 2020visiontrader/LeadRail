-- 040_social_automations.sql — standing rules that act on social activity.
--
-- A row here is a RULE, not an action: "when a comment matching X arrives on
-- this connected account, reply with this template". That is a different risk
-- class from a single send — approving one post authorises one action, while
-- approving a rule authorises an unbounded stream of future sends with no
-- further human in the loop. Hence the `standing_rule` gate in
-- lib/capabilities/types.ts and the two safety properties baked in here:
--
--   1. `enabled` defaults to FALSE. Creating a rule and switching it on are two
--      separate approvals; a single approval can never produce a live
--      auto-sender.
--   2. `daily_cap` is bounded by a DB-level CHECK (not just app validation), so
--      no code path — capability, MCP caller, or the Packet 7.3 runner — can
--      store a rule that is allowed to send more than 200 times a day.
--
-- `sends_today` / `last_reset_at` are the counters the execution runner
-- (Packet 7.3, NOT this packet) increments and resets on date change. Until
-- that runner exists these rows never fire, which is the safe failure mode.
--
-- Scoping/RLS convention matches 028_approvals.sql: account_id UUID NOT NULL,
-- RLS enabled with no anon policies — service-role bypasses and the app scopes
-- every read/write by account_id in code (see lib/capabilities/social-automations.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS social_automations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,                          -- validated against SOCIAL_PROVIDERS in code, not by an enum here
  external_id   TEXT NOT NULL,                          -- which connected account (integration_connections.external_id) this rule runs for
  trigger       TEXT NOT NULL,                          -- 'comment_received' | 'dm_received' | 'mention'
  match         JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {keywords:[], regex?}
  action        TEXT NOT NULL,                          -- 'reply' | 'hide' | 'notify' | 'tag_lead'
  template      TEXT,                                   -- reply body, when action='reply'
  daily_cap     INT NOT NULL DEFAULT 25,                -- HARD upper bound on sends per day
  sends_today   INT NOT NULL DEFAULT 0,
  last_reset_at DATE,
  enabled       BOOLEAN NOT NULL DEFAULT false,         -- created DISABLED; enabling is its own approval
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_automations_cap_check CHECK (daily_cap > 0 AND daily_cap <= 200),
  CONSTRAINT social_automations_trigger_check CHECK (trigger IN ('comment_received','dm_received','mention')),
  CONSTRAINT social_automations_action_check CHECK (action IN ('reply','hide','notify','tag_lead'))
);
CREATE INDEX IF NOT EXISTS idx_social_automations_account ON social_automations(account_id, enabled);

ALTER TABLE social_automations ENABLE ROW LEVEL SECURITY;
