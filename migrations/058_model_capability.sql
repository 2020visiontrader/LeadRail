-- Eligibility inputs for the model selector.
--
-- The selector could order candidates but not exclude them: every enabled model
-- was considered for every call, and a model too small for the prompt was
-- discovered by sending the prompt and reading the error. On the agent's route
-- pass — which carries the tool catalogue and a growing transcript — that is a
-- full round trip and a timeout to learn something the row already knows.
--
-- context_window is the hard filter. cost_per_* is the tiebreak: given two
-- models that can both do the job, the cheaper one should win the steps where
-- quality is not the constraint, and that is not decidable without a number.
--
-- NULL everywhere means unknown, and unknown must never read as free or as
-- infinite. Callers treat NULL as "cannot rule this in or out" and fall back to
-- the per-kind defaults, exactly as max_output_tokens (migration 038) does.

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS context_window INT;
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_mtok_in NUMERIC(12, 6);
ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS cost_per_mtok_out NUMERIC(12, 6);

COMMENT ON COLUMN ai_models.context_window IS
  'Total input+output token capacity. NULL means unknown; callers must not assume a value.';
COMMENT ON COLUMN ai_models.cost_per_mtok_in IS
  'USD per million input tokens. 0 is a real value (free tier); NULL means unknown and is NOT free.';
COMMENT ON COLUMN ai_models.cost_per_mtok_out IS
  'USD per million output tokens. 0 is a real value (free tier); NULL means unknown and is NOT free.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_models_context_window_check'
          AND conrelid = 'ai_models'::regclass
    ) THEN
        ALTER TABLE ai_models
        ADD CONSTRAINT ai_models_context_window_check
        CHECK (context_window IS NULL OR context_window > 0);
    END IF;

    -- Zero is allowed and meaningful here: the free OpenRouter roster genuinely
    -- costs nothing per token. Negative is not.
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_models_cost_check'
          AND conrelid = 'ai_models'::regclass
    ) THEN
        ALTER TABLE ai_models
        ADD CONSTRAINT ai_models_cost_check
        CHECK (
          (cost_per_mtok_in IS NULL OR cost_per_mtok_in >= 0)
          AND (cost_per_mtok_out IS NULL OR cost_per_mtok_out >= 0)
        );
    END IF;
END $$;
