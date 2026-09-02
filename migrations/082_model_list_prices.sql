-- 082_model_list_prices.sql — one sourced price correction, and a written
-- record of which rows stay NULL so nobody "backfills" them next time.
--
-- WHY THIS IS SMALL. The brief this migration answers said cost_per_mtok_in /
-- cost_per_mtok_out were "NULL for every model except two paid DeepSeek
-- rows", so the platform could not compute its own spend. Queried against
-- production on 2026-09-02 that is not what the table holds: 25 of 44
-- ai_models rows already carry prices, including ALL FOUR enabled OpenRouter
-- models and every disabled `:free` row (at 0.00, which migration 077 set
-- deliberately — see the paid/free note below). The backfill was already done
-- by migrations 073 and 077.
--
-- What IS still NULL is NULL on purpose, and setting it would invent money:
--
--   OpenCode Go, 10 enabled rows (deepseek-v4-flash, deepseek-v4-pro,
--     deepseek-v4-flash-vision-exp, glm-5.3, glm-5.3-flash, qwen3.8-max,
--     qwen3.8-flash, kimi-k3, kimi-k2.7-code, minimax-m3)
--       — subscription (Zen) plan, no published per-token price. Migration
--         077 states the rule this migration is not going to break: NULL
--         means "not billed per token here", which is a DIFFERENT fact from
--         0.00 ("free tier, rate limited"), and conflating them is what made
--         the old catalogue unusable. These models have per-token prices on
--         OpenRouter, but that is a different provider's bill; writing an
--         OpenRouter price onto a subscription row would report spend that
--         this account does not incur.
--   Zo Ask `__default__` — same shape, account-default model on a plan that
--         publishes no per-token rate.
--   HuggingFace (3 rows) and NVIDIA NIM (4 rows) — all DISABLED, and their
--         effective rate depends on which inference provider serves the model
--         at request time. No single sourceable list price exists.
--   openai/gpt-5.6-luna, openai/gpt-oss-120b, and the other OpenRouter rows
--         keep the prices migrations 073/077 recorded from openrouter.ai's
--         live /models endpoint. Unverifiable from here (openrouter.ai is
--         unreachable from the environment this was written in), so they are
--         left exactly as they are rather than re-guessed.
--
-- THE ONE CORRECTION. anthropic/claude-sonnet-5 is recorded at 3.00 in /
-- 10.00 out. The output price is right; the input price is not, and it is
-- wrong in a specific, dateable way. Anthropic's published pricing
-- (https://platform.claude.com/docs/en/about-claude/pricing, read 2026-09-02)
-- lists Claude Sonnet 5 at $2 / MTok input and $10 / MTok output, with an
-- explicit note: the $2/$10 pricing "announced at launch as introductory
-- pricing through August 31, 2026, is now the standard price. The previously
-- scheduled increase to $3/$15 per million input/output tokens on September
-- 1, 2026 will not occur." 3.00 is the input half of that cancelled increase.
-- The catalogue was written on 2026-08-29, three days before it would have
-- taken effect. OpenRouter passes Anthropic's list price through for
-- anthropic/* slugs, so $2.00 is the figure for this row too.
--
-- Left alone for the same reason it is correct: anthropic/claude-haiku-4.5 at
-- 1.00 / 5.00 matches the same published table exactly.
--
-- SAFE TO APPLY, AND HERE IS WHY THAT NEEDED CHECKING. cost_per_mtok_out is
-- not just a display number — lib/ai/providers.ts::isPaidModel reads
-- `cost_per_mtok_out > 0` as THE paid/free signal, and orderByCost reorders
-- the routing chain on it (paid first for reason/long/draft/code, free first
-- for classify/extract). Writing a price onto a row that currently has none
-- would silently change which model answers which task. This migration
-- touches only cost_per_mtok_IN, on a row that is already paid, so no
-- paid/free verdict and no chain order changes.
--
-- Idempotent: a plain UPDATE guarded on the exact stale value, so re-running
-- it after it has been applied matches nothing and does nothing.

UPDATE ai_models m
SET cost_per_mtok_in = 2.00
FROM ai_providers p
WHERE p.id = m.provider_id
  AND p.name = 'OpenRouter'
  AND m.model_id = 'anthropic/claude-sonnet-5'
  AND m.cost_per_mtok_in = 3.00;
