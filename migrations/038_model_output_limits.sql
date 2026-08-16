-- The compose pass (Packet 8.1) hardcoded maxOutputTokens 2000 and callModel fell back to 2048,
-- which starves a model that can emit far more and over-requests from one capped lower.
-- This column records each model's real output ceiling so the budget follows the model actually selected.
-- NULL means unknown -> callers fall back to a conservative default.

ALTER TABLE ai_models ADD COLUMN IF NOT EXISTS max_output_tokens INT;

COMMENT ON COLUMN ai_models.max_output_tokens IS 'Per-model maximum output token limit; NULL means unknown, callers should fall back to a conservative default.';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'ai_models_max_output_tokens_check'
          AND conrelid = 'ai_models'::regclass
    ) THEN
        ALTER TABLE ai_models
        ADD CONSTRAINT ai_models_max_output_tokens_check
        CHECK (max_output_tokens IS NULL OR max_output_tokens > 0);
    END IF;
END $$;
