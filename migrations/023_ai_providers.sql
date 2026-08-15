-- 023_ai_providers.sql — Configurable AI provider/model registry, per account.
--
-- Replaces (additively — the hardcoded ladder in lib/ai/router.ts stays as the
-- zero-config fallback) the fixed Zo Ask -> OpenCode -> NIM chain with an
-- account-owned registry: providers (credentials + endpoint), models (per
-- provider, tiered + tagged), and routing (which model is active + the ordered
-- fallback chain). API keys are stored encrypted (see lib/ai/crypto.ts) — this
-- migration only defines the column; encryption happens in application code
-- with AES-256-GCM under AI_VAULT_KEY, never in SQL.
--
-- Scoping convention matches 004/005: account_id UUID NOT NULL. brand_id is
-- intentionally omitted from ai_providers/ai_models — provider credentials are
-- an account-level resource (like integration_connections), not per-venture.
-- ai_routing is account-wide too, since "which model answers" is an account
-- setting; a future per-persona override can layer on top (see brands TODO
-- below) without changing this shape.
--
-- Idempotent; safe to re-run. RLS enabled with no anon policies, consistent
-- with every other table in this schema — the app (service-role client) scopes
-- all reads/writes by account_id; RLS just guarantees the anon/browser key can
-- never see or touch these rows directly.

CREATE TABLE IF NOT EXISTS ai_providers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,                 -- operator-facing label, e.g. "Team OpenAI"
  kind               TEXT NOT NULL,                  -- openai-compatible | anthropic | zoask | opencode | nim | gemini | custom
  base_url           TEXT,                           -- override endpoint; NULL uses the kind's default
  api_key_encrypted  TEXT,                           -- AES-256-GCM ciphertext (lib/ai/crypto.ts); NULL for zoask/opencode/nim/gemini when they ride the platform's own env key
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_providers_kind_check CHECK (kind IN ('openai-compatible','anthropic','zoask','opencode','nim','gemini','custom'))
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_account ON ai_providers(account_id);

CREATE TABLE IF NOT EXISTS ai_models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,                         -- upstream model identifier, e.g. "gpt-4.1" / "claude-sonnet-4-5"
  label       TEXT,                                  -- operator-facing display name; defaults to model_id in the UI
  tier        TEXT NOT NULL DEFAULT 'balanced',       -- fast | balanced | heavy
  good        TEXT[] NOT NULL DEFAULT '{}',           -- task tags this model is routed for, e.g. {classify,draft}
  reliable    BOOLEAN NOT NULL DEFAULT TRUE,          -- false = catalogued but not auto-routed (mirrors lib/ai/models.ts GoModel.reliable)
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_models_tier_check CHECK (tier IN ('fast','balanced','heavy'))
);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- One routing row per account: the active model + an ordered fallback chain of
-- ai_models.id values (jsonb array, not a FK array, so the chain can be
-- reordered/pruned without a join table). Application code validates each id
-- still resolves to an enabled model belonging to this account at call time.
CREATE TABLE IF NOT EXISTS ai_routing (
  account_id       UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  active_model_id  UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  fallback_chain   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered [ai_models.id, ...], tried after active_model_id
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional per-persona/venture model override. Trivial add (mirrors 019's
-- ALTER-COLUMN style); NULL means "use the account's ai_routing default".
ALTER TABLE brands ADD COLUMN IF NOT EXISTS preferred_model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL;

-- Per-call usage ledger — every generateText/generateChat call through the
-- registry path records who answered + what it cost, extending (not
-- replacing) the credits.ts ledger in credit_transactions. Kept separate from
-- credit_transactions because this is a technical/observability log (raw
-- tokens + latency + which tier), not a billing-balance mutation; a caller
-- that also wants to spend credits still calls applyCredits() itself, keyed
-- off ref_id = ai_usage.id, so nothing double-bills.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_id   UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  model_id      UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  model_label   TEXT,                                 -- denormalized snapshot; survives provider/model deletion
  kind          TEXT NOT NULL DEFAULT 'text',          -- text | chat
  tokens_in     INT,
  tokens_out    INT,
  latency_ms    INT,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_account ON ai_usage(account_id, created_at DESC);

-- RLS parity with the rest of the schema (service-role bypasses; app scopes by
-- account_id in every query — see lib/ai/providers.ts).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_providers','ai_models','ai_routing','ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
