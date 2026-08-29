-- 077_provider_catalogue_restructure.sql — put the right models behind the
-- right providers, and stop free models serving real work.
--
-- WHY THIS EXISTS. Production spent a day failing on models that do not fail
-- fast: OpenRouter ":free" slugs returned empty responses or 502s rather than
-- erroring, so the ladder never fell through — it waited. Measured on a live
-- turn: single calls of 110-225s against the generic openrouter tier, while
-- the registry path answered the same prompts in 3-26s. A batch of 10 drafts
-- came back "4 of 10 succeeded, 6 failed", every failure a free slug.
--
-- Every model_id below was read from the provider's LIVE /models endpoint on
-- 2026-08-29, not from a display name. That distinction matters: "GPT Luna"
-- resolves to openai/gpt-5.6-luna, while the similarly-named
-- sao10k/l3-lunaris-8b is an unrelated model that would have been the wrong
-- guess.
--
-- WHAT THIS DOES NOT DO. It does not implement task->provider routing (send
-- research to OpenCode, drafting to Haiku, verification to Sonnet). That is a
-- router change, not a catalogue change, and pretending a row in this table
-- expresses it would be the "configured in prose, never in a config file"
-- pattern this repo already counts eleven instances of. The catalogue only
-- makes the right models AVAILABLE; what selects them is lib/ai/providers.ts.

-- CONTEXT WINDOWS (added after first apply). OpenCode's endpoint returns no
-- context_window, so a first pass set a conservative 128000 across the board.
-- That was 8-10x too low and would have truncated heavily. The right source is
-- OpenRouter's live catalogue for the SAME models: a subscription key changes
-- the billing, not the model. Verified 2026-08-29 and applied per model, which
-- mattered - kimi-k2.7-code is genuinely 262144 while its siblings are ~1M.
--   deepseek-v4-flash 1310720 | deepseek-v4-pro 1048576
--   deepseek-v4-flash-vision-exp 1048576 | glm-5.3 1310720
--   glm-5.3-flash 1310720 | qwen3.8-max 1000000 | qwen3.8-flash 1000000
--   kimi-k3 1048576 | kimi-k2.7-code 262144 | minimax-m3 1048576

-- 1) OpenCode Go: bring in the capable models. Verified live: the endpoint
--    serves 33, of which these are the ones worth routing real work to.
--    cost_per_mtok_* stays NULL deliberately — OpenCode Go is a subscription
--    (Zen) plan and publishes no per-token price. NULL means "not billed per
--    token here", which is a different fact from 0.00 ("free tier, rate
--    limited"), and conflating them is what made the old catalogue unusable.
INSERT INTO ai_models (provider_id, model_id, label, tier, good, enabled)
VALUES
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'deepseek-v4-flash',            'DeepSeek V4 Flash (OpenCode)',      'balanced', ARRAY['reason','code','extract','draft'], true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'deepseek-v4-pro',              'DeepSeek V4 Pro (OpenCode)',        'heavy',    ARRAY['reason','code','long'],            true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision (OpenCode)','balanced', ARRAY['extract','vision','draft'],       true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'glm-5.3',                      'GLM 5.3 (OpenCode)',                'heavy',    ARRAY['reason','long','draft'],           true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'glm-5.3-flash',                'GLM 5.3 Flash (OpenCode)',          'fast',     ARRAY['classify','extract','draft'],      true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'qwen3.8-max',                  'Qwen 3.8 Max (OpenCode)',           'heavy',    ARRAY['reason','long','extract'],         true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'qwen3.8-flash',                'Qwen 3.8 Flash (OpenCode)',         'fast',     ARRAY['classify','extract'],              true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'kimi-k3',                      'Kimi K3 (OpenCode)',                'heavy',    ARRAY['reason','long'],                   true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'kimi-k2.7-code',               'Kimi K2.7 Code (OpenCode)',         'balanced', ARRAY['code','reason'],                   true),
  ('953b200a-ca23-4a2f-a639-9b2863f18151', 'minimax-m3',                   'MiniMax M3 (OpenCode)',             'balanced', ARRAY['draft','reason','long'],           true)
ON CONFLICT DO NOTHING;

-- 2) OpenRouter paid roster. Prices and context windows below are the live
--    values from openrouter.ai/api/v1/models on 2026-08-29, per Mtok output.
--    Claude on OpenRouter is Haiku and Sonnet only, as instructed.
INSERT INTO ai_models (provider_id, model_id, label, tier, good, enabled, context_window, cost_per_mtok_in, cost_per_mtok_out)
VALUES
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1', 'openai/gpt-5.6-luna',        'GPT-5.6 Luna (paid)',      'balanced', ARRAY['draft','reason','long','extract'], true, 1050000, 0.30,  1.20),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1', 'anthropic/claude-haiku-4.5', 'Claude Haiku 4.5 (paid)',  'fast',     ARRAY['draft','classify','extract'],      true,  200000, 1.00,  5.00),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1', 'anthropic/claude-sonnet-5',  'Claude Sonnet 5 (paid)',   'heavy',    ARRAY['reason','long','draft','code'],    true, 1000000, 3.00, 10.00)
ON CONFLICT DO NOTHING;

-- 3) Free models stop serving real work. Disabled rather than deleted: they
--    remain in the catalogue as a documented last resort, and re-enabling one
--    is a single UPDATE if a provider ever fixes its free tier. Deleting them
--    would lose the record of WHY they are off.
UPDATE ai_models
SET enabled = false
WHERE model_id LIKE '%:free%' AND enabled;

-- 4) DeepSeek moves to OpenCode. The OpenRouter copies are redundant now that
--    the OpenCode ones are enabled, and keeping both means the ladder can
--    silently pick the slower path for the same model.
UPDATE ai_models m
SET enabled = false
FROM ai_providers p
WHERE p.id = m.provider_id
  AND p.name = 'OpenRouter'
  AND m.model_id LIKE '%deepseek%'
  AND m.enabled;
