-- 022_agent_conversations.sql — Operator-copilot memory substrate.
-- agent_conversations persists each chat's transcript + carryover so a session
-- can be resumed with context. agent_memory is a lightweight durable-facts store
-- (freeform fact + optional subject/predicate/object triple for future graph use).
-- account_id is UUID to match the multitenant convention (references accounts(id)).

CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id),
  title TEXT,
  transcript JSONB,
  carryover JSONB,
  token_estimate INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_account ON agent_conversations(account_id);

CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  fact TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_account ON agent_memory(account_id);
