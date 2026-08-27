-- ai_usage: make a transport success distinguishable from a usable response,
-- and make a row traceable back to the conversation that produced it.
--
-- Both columns exist because an audit of 364 ai_usage rows could not answer two
-- basic questions.
--
-- 1. parse_ok. `ok` is written by the ai router (lib/ai/router.ts) the moment a
--    tier returns text. But the agent loop then REQUIRES that text to be one
--    JSON envelope (lib/agent/loop.ts), and a model that answers in prose fails
--    the turn while being recorded as a success. Seven such failures were found
--    in production transcripts; every one of them is an `ok = true` row. NULL
--    means the call was not envelope-constrained (plain text generation, the
--    compose pass) — it is not a synonym for false.
--
-- 2. conversation_id. ai_usage had no correlation column of any kind, and
--    app_logs has request_id while ai_usage does not, so the two tables could
--    not be joined even in principle. Attributing a failure to a conversation
--    meant loose timestamp matching, which is not trustworthy when a single
--    turn fans out across several tiers within the same second.
--
-- Both are nullable and additive: every existing writer keeps working and every
-- historical row stays valid, just unclassified.

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS parse_ok BOOLEAN;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS conversation_id UUID;

COMMENT ON COLUMN ai_usage.parse_ok IS
  'Did the caller successfully parse this response? true/false for JSON-envelope calls (the agent route pass); NULL when the call was not envelope-constrained. Independent of ok, which only reports transport success.';
COMMENT ON COLUMN ai_usage.conversation_id IS
  'agent_conversations.id this call belongs to, when the caller has one. No FK: a usage row is an audit fact and must outlive a deleted conversation.';

-- Partial index: the query this exists to serve is "show me the calls that came
-- back but could not be used", which is a small slice of a large table.
CREATE INDEX IF NOT EXISTS idx_ai_usage_parse_failed
  ON ai_usage(account_id, created_at DESC)
  WHERE parse_ok IS FALSE;

CREATE INDEX IF NOT EXISTS idx_ai_usage_conversation
  ON ai_usage(conversation_id, created_at DESC)
  WHERE conversation_id IS NOT NULL;
