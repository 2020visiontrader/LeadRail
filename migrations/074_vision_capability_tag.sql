-- 074_vision_capability_tag.sql — teach the routing ladder that a task can
-- need EYES.
--
-- WHY THIS EXISTS. ai_models.good[] (migration 023) has, until now, only ever
-- carried TASK-SHAPE tags: classify, code, draft, extract, long, reason. None
-- of those say anything about the MEDIUM a model can read. Migration 073
-- expanded the catalogue to 19 enabled OpenRouter models, and nine of them are
-- explicitly vision-capable per OpenRouter's live catalogue (several of them
-- labelled "(vision+video)"/"(vision+audio)" right in the 073 label column) —
-- but nothing in `good[]` said so, because the tag did not exist. A caller with
-- an image attachment had no way to ask the selector for "a model that can
-- actually see this" and no way to be told a text-only model is the wrong
-- answer; it would find out the same way everything in this codebase finds out
-- an eligibility mismatch it wasn't told about — a failed or garbled call.
--
-- THE FIX. Add 'vision' as a new value in the SAME array column, no new
-- column, no new table — good[] was always meant to be an open tag set (see
-- migration 023's own comment: "task tags this model is routed for"), and
-- lib/ai/eligibility.ts and lib/ai/providers.ts already treat it as an
-- arbitrary string list rather than an enum. This migration only UPDATEs
-- existing rows to append the tag; it defines no new schema, which is why it
-- earns no new lib/db/schema-guard.ts entry of its own (see that file's
-- comment on the schema-guard entry for `good`, registered against migration
-- 023 — the migration that actually introduced the column — not this one;
-- schema-guard checks column PRESENCE, not the values inside it, and tying a
-- migration number to a column it did not define is the exact mistake fixed
-- in migration 072/073's own history).
--
-- WHICH IDS. Every id below is one already inserted by migration 073 and
-- verified vision-capable against OpenRouter's live catalogue at the time
-- that migration was written (several carry it directly in their label:
-- "(paid, vision+video)", "(free, vision+audio)", etc.) — this migration adds
-- no new model rows, it only tags existing ones.
--
-- Idempotent: array_position guards against re-adding 'vision' to a row that
-- already carries it (e.g. a second apply after a partial run, or a manual
-- backfill done ahead of this migration), so re-running is a no-op.

UPDATE ai_models
SET good = good || ARRAY['vision']::text[]
WHERE model_id IN (
  'qwen/qwen3.7-flash',
  'qwen/qwen3.5-9b',
  'google/gemma-3-12b-it',
  'z-ai/glm-5.3-flash',
  'thinkingmachines/inkling:free',
  'thinkingmachines/inkling-small:free',
  'minimax/minimax-m3:free',
  'dots-studio/dots-3-note-preview:free',
  'google/gemma-4-31b-it:free',
  'google/gemma-4-26b-a4b-it:free',
  'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free'
)
AND array_position(good, 'vision') IS NULL;

-- EVERYTHING ELSE IN THE 073 ROSTER IS DELIBERATELY LEFT UNTAGGED, including
-- paid models whose 073 label says only "(paid)" with no vision mention
-- (deepseek-v4-flash-0731, gpt-oss-120b) and every other free entry. Tagging a
-- model 'vision' that cannot actually take an image input would let the
-- eligibility filter in lib/ai/eligibility.ts hand a visual task to a model
-- that silently ignores the image — a routing decision that reads as correct
-- right up until someone notices the answer never looked at the picture.
