-- ai_usage: capture provider-reported call duration, distinct from our own
-- wrapper's elapsed clock.
--
-- WHY THIS EXISTS. `ai_usage.latency_ms` (migration 060) is the ROUTER's own
-- Date.now()-to-Date.now() elapsed time around a candidate's run() promise.
-- A call aborted at a timeout looks identical on that number alone whether
-- the provider was generating, sitting in an upstream queue, or the
-- connection never resolved at all — that ambiguity blocked a real
-- production diagnosis. This migration adds a place to record what the
-- PROVIDER itself says its own duration was, when it says anything at all.
--
-- MEASURED, NOT ASSUMED (2026-08-29, live calls against OpenRouter and
-- OpenCode — see tests/provider-timing.test.ts). Neither provider's
-- synchronous chat/completions response — the one this codebase actually
-- calls — carries a timing field, in the body or in headers. OpenRouter DOES
-- report `latency` and `generation_time` (ms), but only from a SEPARATE
-- `GET /generation?id=` lookup keyed off the `x-generation-id` response
-- header; this code does not make that second call. Zo Ask's body is `{output}`
-- and never carries a usage or timing block of any kind (see migration 075's
-- identical finding for tokens). So as of this migration every ladder tier
-- writes provider_not_reported/none for timing on every row — that is the
-- accurate, current, measured state, not a placeholder bug. The columns and
-- classification exist so (a) that state is visible and distinguishable from
-- "we never looked", per the pattern below, and (b) a provider that starts
-- reporting timing inline, or a follow-up call to OpenRouter's /generation
-- endpoint, needs no schema change to start writing real numbers.
--
-- SAME CLASSIFICATION CONVENTION AS MIGRATION 075, deliberately not a new
-- one (see CLAUDE.md: "follow the established pattern, do not invent a
-- second convention"):
--
--   timing_status:
--     reported               — a provider returned a usable duration.
--     provider_not_reported  — we asked (parsed the response) and the
--                               provider's payload genuinely has no timing
--                               field. The permanent state for Zo Ask, and
--                               the current measured state for OpenRouter
--                               and OpenCode's synchronous responses.
--     capture_failed         — extraction was attempted and threw.
--     not_attempted          — the call path never opened or never
--                               consulted the timing capture scope. Exists
--                               so a real telemetry gap in a NEW code path
--                               stays visible instead of silently reading as
--                               "provider_not_reported", which would assert
--                               a specific, checked fact nobody checked.
--     not_applicable         — reserved, matching 075; nothing writes it yet.
--
--   timing_source: provider | estimated | none. Nothing in this codebase
--     writes 'estimated' as of this migration — a duration is never derived
--     from our own elapsed clock and relabelled as the provider's.
--
-- provider_latency_ms is a SEPARATE column from latency_ms, never a
-- replacement for it: latency_ms is always present (our own clock never
-- "fails to report"); provider_latency_ms is null whenever timing_status is
-- anything other than 'reported'.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS plus a guarded DO block for each CHECK
-- constraint (Postgres has no ADD CONSTRAINT IF NOT EXISTS), matching the
-- pattern in migrations 058 and 075. Re-running against an up-to-date
-- database is a no-op. No backfill: every existing row predates timing
-- classification entirely, so it keeps the not_attempted/none default rather
-- than a guess — the same reasoning migration 075 used for pre-075 token rows.

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS provider_latency_ms integer;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS timing_status text NOT NULL DEFAULT 'not_attempted';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS timing_source text NOT NULL DEFAULT 'none';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_usage_timing_status_check'
          AND conrelid = 'ai_usage'::regclass
    ) THEN
        ALTER TABLE ai_usage
        ADD CONSTRAINT ai_usage_timing_status_check
        CHECK (timing_status IN ('reported', 'provider_not_reported', 'capture_failed', 'not_attempted', 'not_applicable'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_usage_timing_source_check'
          AND conrelid = 'ai_usage'::regclass
    ) THEN
        ALTER TABLE ai_usage
        ADD CONSTRAINT ai_usage_timing_source_check
        CHECK (timing_source IN ('provider', 'estimated', 'none'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_usage_provider_latency_ms_check'
          AND conrelid = 'ai_usage'::regclass
    ) THEN
        ALTER TABLE ai_usage
        ADD CONSTRAINT ai_usage_provider_latency_ms_check
        CHECK (provider_latency_ms IS NULL OR provider_latency_ms >= 0);
    END IF;
END $$;

COMMENT ON COLUMN ai_usage.provider_latency_ms IS
  'Call duration in ms as reported BY THE PROVIDER, distinct from latency_ms (this row''s own wrapper-measured elapsed time, always present). NULL unless timing_status = ''reported''. See migration 078.';
COMMENT ON COLUMN ai_usage.timing_status IS
  'Why provider_latency_ms is (or is not) populated: reported, provider_not_reported, capture_failed, not_attempted, or not_applicable. See migration 078 for the full definition of each, and migration 075 for the identical convention applied to tokens.';
COMMENT ON COLUMN ai_usage.timing_source IS
  'Where a reported duration came from: provider, estimated, or none. Nothing in this codebase writes ''estimated'' as of migration 078 — a duration is never derived from our own elapsed clock.';
