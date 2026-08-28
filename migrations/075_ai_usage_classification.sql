-- ai_usage: make a NULL token count answer a question instead of hiding one.
--
-- WHY THIS EXISTS. Production, queried directly: of 281 successful ladder
-- calls, zoask answered 168 of them (more than every other tier combined) and
-- captured tokens on ZERO of them. openrouter and nim captured on 100%. Before
-- this migration, tokens_in/tokens_out being NULL could mean any of three
-- unrelated things: "this provider does not supply usage" (Zo Ask, always),
-- "we never looked" (a code path that predates lib/ai/usage.ts, or a future
-- one that forgets to open it), or "we looked and the extraction blew up".
-- Those are different facts with different fixes, and a single NULL column
-- could not tell them apart — which is exactly how 60% of production traffic
-- came to look like an unmeasured telemetry gap instead of the known,
-- unavoidable behaviour of one specific provider.
--
-- THE FIX. Two classification columns, written by the SAME single write path
-- that already exists (lib/ai/usage.ts -> lib/ai/router.ts::logUsage ->
-- lib/credits.ts::recordAiUsage -> this table). No estimation is introduced —
-- 'estimated' is a valid usage_source value because the CHECK constraint must
-- allow it eventually, but nothing in this migration or the change that ships
-- alongside it ever writes it. Inventing a token count would be worse than
-- leaving the gap visible.
--
--   usage_status:
--     reported               — a provider returned a usable usage block.
--     provider_not_reported  — we asked (parsed the response) and the
--                               provider's payload genuinely has no usage
--                               field. Zo Ask's client returns only
--                               `{output}`; this is its permanent state, not
--                               a bug to chase.
--     capture_failed         — extraction was attempted and threw.
--     not_attempted          — the call path never opened or never consulted
--                               the usage capture scope. Exists so a real
--                               telemetry gap in a NEW code path stays
--                               visible instead of silently reading as
--                               "provider_not_reported", which would say a
--                               specific, checked fact that nobody checked.
--     not_applicable         — reserved for a call that is not a model call
--                               at all. Nothing in the current write path
--                               produces this; it exists so the constraint
--                               does not need to be widened the first time
--                               one does.
--
--   usage_source: provider | estimated | none.
--
-- BACKFILL — deliberately incomplete, and that is the honest answer, not a
-- shortcut. A row with a non-null tokens_out came from a provider that
-- reported real numbers; those rows are unambiguously reported/provider.
-- Every other existing row is left at the column DEFAULT, not_attempted/none,
-- because the pre-075 code had no status concept at all: there is no way to
-- tell, after the fact, whether an old NULL-token row came from Zo Ask
-- (which would now read provider_not_reported), a transport failure, or a
-- silent code path. Writing provider_not_reported onto all of them would
-- invent history the old rows never recorded — the exact mistake this
-- migration exists to stop making going forward. not_attempted is honest
-- here in a different sense than it is for new rows: it says "this row
-- predates classification," which is true, rather than asserting a specific
-- provider behaviour nobody captured at the time.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS plus a guarded DO block for each CHECK
-- constraint (Postgres has no ADD CONSTRAINT IF NOT EXISTS), matching the
-- pattern in migration 058. Re-running against an up-to-date database is a
-- no-op.

ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS usage_status text NOT NULL DEFAULT 'not_attempted';
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS usage_source text NOT NULL DEFAULT 'none';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_usage_usage_status_check'
          AND conrelid = 'ai_usage'::regclass
    ) THEN
        ALTER TABLE ai_usage
        ADD CONSTRAINT ai_usage_usage_status_check
        CHECK (usage_status IN ('reported', 'provider_not_reported', 'capture_failed', 'not_attempted', 'not_applicable'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_usage_usage_source_check'
          AND conrelid = 'ai_usage'::regclass
    ) THEN
        ALTER TABLE ai_usage
        ADD CONSTRAINT ai_usage_usage_source_check
        CHECK (usage_source IN ('provider', 'estimated', 'none'));
    END IF;
END $$;

COMMENT ON COLUMN ai_usage.usage_status IS
  'Why tokens_in/tokens_out are (or are not) populated: reported, provider_not_reported, capture_failed, not_attempted, or not_applicable. See migration 075 for the full definition of each.';
COMMENT ON COLUMN ai_usage.usage_source IS
  'Where a reported number came from: provider, estimated, or none. Nothing in this codebase writes ''estimated'' as of migration 075 — token counts are never invented.';

-- Rows that already carry a real token count are unambiguously reported/
-- provider; everything else keeps the not_attempted/none default rather than
-- being guessed at (see comment above).
UPDATE ai_usage
SET usage_status = 'reported', usage_source = 'provider'
WHERE tokens_out IS NOT NULL
  AND usage_status = 'not_attempted';
