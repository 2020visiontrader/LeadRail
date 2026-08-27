-- 065_model_context_windows.sql — give ai_models.context_window actual values.
--
-- Migration 058 added the column. Nothing ever wrote to it: all 15 rows are
-- NULL in production, which means checkEligibility's window check
-- (lib/ai/eligibility.ts) has silently never fired, and the per-model context
-- budgeting in lib/ai/context-budget.ts has nothing to read.
--
-- That is the fifth column in this codebase added and never populated. The
-- pattern is consistent enough to be worth naming: a schema change ships, the
-- reader ships later or not at all, and the gap is invisible because every
-- consumer degrades quietly.
--
-- WHY IT MATTERS NOW. The platform caps attachments, observations, transcripts
-- and memory as fractions of the answering model's window. With no window
-- recorded, every one of those falls back to a default. Populating this is what
-- makes the budgets adapt per model — and what makes a model added tomorrow
-- work without a code change, provided its row carries a window.
--
-- Values are the published context windows for each model family. Matched on
-- model_id so a re-run is idempotent and a model that is later renamed simply
-- stops matching rather than getting a wrong number.

-- Claude family (via Zo Ask / an Anthropic provider): 1M on the current models.
UPDATE ai_models SET context_window = 1000000
 WHERE context_window IS NULL
   AND (model_id ILIKE '%opus-5%' OR model_id ILIKE '%sonnet-5%'
        OR model_id ILIKE '%opus-4%' OR model_id ILIKE '%fable-5%');

UPDATE ai_models SET context_window = 200000
 WHERE context_window IS NULL AND model_id ILIKE '%haiku%';

-- The registry's Zo Ask row carries the sentinel `__default__` rather than a
-- real model id (see lib/ai/zoask.ts) — the account default is whatever the Zo
-- account is set to. 200k is the conservative floor of the plausible set: too
-- low only if the account runs Opus/Sonnet 5, which over-truncates rather than
-- overflowing, and an operator who knows better sets
-- AGENT_CONTEXT_WINDOW_TOKENS.
UPDATE ai_models SET context_window = 200000
 WHERE context_window IS NULL AND model_id = '__default__';

-- Open-weight tiers.
UPDATE ai_models SET context_window = 262144
 WHERE context_window IS NULL AND model_id ILIKE '%qwen%';

UPDATE ai_models SET context_window = 128000
 WHERE context_window IS NULL
   AND (model_id ILIKE '%deepseek%' OR model_id ILIKE '%nemotron%'
        OR model_id ILIKE '%llama%'  OR model_id ILIKE '%gpt-oss%'
        OR model_id ILIKE '%gemma%'  OR model_id ILIKE '%mistral%');

COMMENT ON COLUMN ai_models.context_window IS
  'Total context window in tokens. Read by lib/ai/eligibility.ts to exclude models that cannot hold a prompt, and by lib/ai/context-budget.ts to size attachment/observation/transcript budgets per model. A new model only needs this set for its full capacity to be used.';
