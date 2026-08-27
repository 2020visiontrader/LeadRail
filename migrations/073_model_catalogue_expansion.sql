-- 073_model_catalogue_expansion.sql — give the routing ladder real rungs.
--
-- WHY THIS EXISTS. Two enabled OpenRouter models pointed at slugs that no
-- longer exist upstream (openai/gpt-oss-20b:free, nvidia/nemotron-3-nano-30b-
-- a3b:free). Both were marked reliable:true while being incapable of ever
-- answering, so every turn that reached them paid a full round-trip, took a
-- 404, quarantined for 60s and moved on -- 172 candidate failures and 84
-- quarantines in 24 hours. With HuggingFace simultaneously out of monthly
-- credit (402) and NIM timing out, turns ran out of ladder and ended with no
-- answer at all.
--
-- EVERY id, context window and price below was read from OpenRouter's live
-- catalogue (GET https://openrouter.ai/api/v1/models -- public, no key), not
-- from memory. That endpoint is also what /api/admin/model-catalogue already
-- checks against; it existed and had never been run, which is why the drift
-- went unnoticed. Verifying against the provider is the whole point.
--
-- THE PAID CAP is < $0.25 per million OUTPUT tokens. That excludes every
-- Moonshot/Kimi model (cheapest output $2.30/M) and every MiniMax ($1.10/M).
-- GLM 5.3 Flash is admitted at exactly $0.250 by explicit decision: it is the
-- cheapest GLM by OUTPUT price (glm-4.7-flash is cheaper on input but $0.400
-- out) and it carries the largest context of the set plus vision and video.
--
-- WHY NON-REQUESTED FAMILIES ARE HERE. Under the cap only DeepSeek and Qwen
-- qualified from the families originally asked for. A ladder whose paid rungs
-- all come from one or two vendors fails together when that vendor does --
-- which is precisely the failure being fixed. Gemma and GPT-OSS are carried
-- for failover diversity, not preference.
--
-- Idempotent: NOT EXISTS on (provider_id, model_id), so re-running is a no-op
-- and this is safe to apply on top of rows already inserted by hand.

insert into ai_models (
  provider_id, model_id, label, tier, good, reliable, enabled,
  max_output_tokens, context_window, cost_per_mtok_in, cost_per_mtok_out
)
select v.* from (values
  -- ---------- PAID (output <= $0.25/M) ----------
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'deepseek/deepseek-v4-flash-0731','DeepSeek V4 Flash 0731 (paid)','heavy',array['long','reason','extract'],true,true,16000,1310720,0.060,0.120),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'qwen/qwen3.7-flash','Qwen3.7 Flash (paid, vision+video)','balanced',array['draft','classify','long','extract'],true,true,16000,1000000,0.030,0.130),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'qwen/qwen3.5-9b','Qwen3.5 9B (paid, vision+video)','fast',array['classify','extract','draft'],true,true,8000,262144,0.100,0.150),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'google/gemma-3-12b-it','Gemma 3 12B (paid, vision)','fast',array['classify','draft'],true,true,8000,131072,0.050,0.150),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'openai/gpt-oss-120b','GPT-OSS 120B (paid)','balanced',array['reason','draft','extract'],true,true,16000,131072,0.037,0.170),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'z-ai/glm-5.3-flash','GLM 5.3 Flash (paid, vision+video)','balanced',array['reason','long','draft'],true,true,16000,1310720,0.075,0.250),
  -- ---------- FREE ----------
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'thinkingmachines/inkling:free','Inkling (free, vision+audio)','heavy',array['reason','long','extract'],true,true,16000,1048576,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'thinkingmachines/inkling-small:free','Inkling Small (free, vision+audio)','fast',array['classify','extract','long'],true,true,8000,1048576,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'minimax/minimax-m3:free','MiniMax M3 (free, vision+video)','balanced',array['draft','reason','long'],true,true,16000,1048576,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'dots-studio/dots-3-note-preview:free','Dots 3 Note (free, vision)','balanced',array['extract','draft'],true,true,8000,512000,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'google/gemma-4-31b-it:free','Gemma 4 31B (free, vision+video)','balanced',array['draft','classify'],true,true,8000,262144,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'google/gemma-4-26b-a4b-it:free','Gemma 4 26B (free, vision+video)','fast',array['classify','draft'],true,true,8000,262144,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'nvidia/nemotron-3-super-120b-a12b:free','Nemotron 3 Super 120B (free)','balanced',array['reason','draft'],true,true,16000,262144,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'z-ai/glm-5.2:free','GLM 5.2 (free)','balanced',array['reason','draft'],true,true,16000,256000,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free','Nemotron 3 Nano Omni (free, multimodal)','fast',array['classify','reason'],true,true,8000,256000,0,0),
  ('97cbf68c-7f4c-4316-b0b6-37231c17e5f1'::uuid,'minimax/minimax-m2.7:free','MiniMax M2.7 (free)','fast',array['draft','classify'],true,true,8000,196608,0,0)
) as v(provider_id, model_id, label, tier, good, reliable, enabled,
       max_output_tokens, context_window, cost_per_mtok_in, cost_per_mtok_out)
where not exists (
  select 1 from ai_models m
  where m.provider_id = v.provider_id and m.model_id = v.model_id
);

-- Deliberately EXCLUDED from the free set, so nobody re-adds them wondering
-- why they were skipped: poolside/laguna-* and cohere/north-mini-code are
-- code-specialists; nvidia/nemotron-3.5-content-safety is a safety classifier,
-- not a chat model; liquid/lfm-2.5-2.6b is 2.6B with a 64k window -- too small
-- to carry a real turn on this platform.
--
-- NVIDIA NIM was NOT expanded here on purpose. Its catalogue
-- (integrate.api.nvidia.com/v1/models, 84 models, also public) returns id and
-- owner only -- no context window, no pricing. Guessing a context_window is
-- exactly the mistake this migration is cleaning up: the selector excludes any
-- model whose window is too small for the prompt, so a number invented here
-- would silently disqualify good models. Establish real values with
-- /api/admin/model-probe first, then add them.
