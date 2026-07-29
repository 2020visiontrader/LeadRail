-- 011_typed_sequencing.sql
-- Phase C: typed sequencing & light intelligence.
-- Items 6 (typed steps + A/B variants), 7 (business-hours scheduling),
-- 8 (structured reply outcomes), 16 (saved ICP), 17 (async enrichment jobs).
-- Extends the Phase A send loop; safe to run after 004..010. Idempotent.

-- ---------------------------------------------------------------------------
-- #6 Typed steps. A step is one of:
--   email  — resolve content (or a variant) and send        (default; today's behaviour)
--   wait   — no send; just advance and schedule the next step after delay_hours
--   manual — pause the enrollment and open a human task (activity), resume on completion
--   task   — like manual but the enrollment keeps flowing (fire-and-forget reminder)
--   branch — reserved; treated as a no-op skip until the rules engine (Phase D) lands
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'email';

-- A/B variants for a step. When a step has ≥1 variant, the engine picks one by
-- weight and sends its content instead of the step's own subject/body. Per-variant
-- counters give a real A/B funnel (mirrors sequence_steps.*_count from Phase A).
CREATE TABLE IF NOT EXISTS sequence_step_variants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id UUID NOT NULL REFERENCES sequence_steps(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT 'A',             -- A | B | C ...
  subject TEXT,
  body TEXT,
  template_id UUID,                            -- optional message_templates ref
  weight INT NOT NULL DEFAULT 1,               -- relative selection weight (>=0)
  sent_count INT NOT NULL DEFAULT 0,
  open_count INT NOT NULL DEFAULT 0,
  click_count INT NOT NULL DEFAULT 0,
  reply_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_step_variants_step ON sequence_step_variants(step_id);

-- Attribute opens/clicks to the exact variant that was sent.
ALTER TABLE email_events ADD COLUMN IF NOT EXISTS variant_id UUID;
-- Remember the variant used on the current step so reply/open counters land on it.
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS last_variant_id UUID;

-- Generic per-variant counter bump (parallels increment_step_counter from 009).
CREATE OR REPLACE FUNCTION increment_variant_counter(p_variant UUID, p_col TEXT)
RETURNS void AS $$
BEGIN
  IF p_col NOT IN ('sent_count','open_count','click_count','reply_count') THEN
    RAISE EXCEPTION 'invalid column %', p_col;
  END IF;
  EXECUTE format('UPDATE sequence_step_variants SET %I = %I + 1 WHERE id = $1', p_col, p_col)
    USING p_variant;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #7 Business-hours scheduling. Sends are shifted into a working window so
-- follow-ups don't fire at 3am. Per-sequence override wins over account default;
-- both null = 24/7 (current behaviour). Shape:
--   { "tz": "America/Toronto", "days": [1,2,3,4,5], "start": 9, "end": 17 }
--   days: ISO weekday 1=Mon..7=Sun; start/end: hour-of-day in tz.
-- Evaluated in TypeScript (lib/business-hours.ts); columns are just storage.
-- ---------------------------------------------------------------------------
ALTER TABLE accounts   ADD COLUMN IF NOT EXISTS business_hours JSONB;
ALTER TABLE sequences  ADD COLUMN IF NOT EXISTS business_hours JSONB;

-- ---------------------------------------------------------------------------
-- #8 Structured reply outcomes. When reply-stop fires we classify the inbound
-- message so the funnel is more than "replied": one of
--   converted | not_interested | no_budget | has_solution | bad_timing | unknown
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS outcome TEXT;

-- ---------------------------------------------------------------------------
-- #16 Saved ICP profiles. A named, reusable Apollo query (the same JSON shape
-- as apollo_searches.query) so an operator saves an ICP once and re-runs it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS icp_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,   -- null = account-wide
  name TEXT NOT NULL,
  query JSONB NOT NULL,                        -- {industry, titles[], seniority[], location, size, keywords}
  last_run_at TIMESTAMPTZ,
  last_result_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_icp_profiles_account ON icp_profiles(account_id);

-- ---------------------------------------------------------------------------
-- #17 Two-leg async enrichment handshake. Enrichment becomes a job row instead
-- of an inline call, so a slow/failed provider can't block a request and the
-- selection query can exclude contacts with an in-flight job (no double-spend).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS enrichment_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'person',         -- person | company
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | running | done | failed
  provider TEXT NOT NULL DEFAULT 'apollo',
  handle TEXT,                                 -- external job ref, when the provider is async
  result JSONB,
  error TEXT,
  attempts INT NOT NULL DEFAULT 0,
  claim_id UUID,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_account ON enrichment_jobs(account_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_jobs_status  ON enrichment_jobs(status, created_at) WHERE status IN ('pending','running');
-- One live job per contact: excludes in-flight from re-queue (the handshake guard).
CREATE UNIQUE INDEX IF NOT EXISTS uniq_enrichment_job_live_contact
  ON enrichment_jobs(contact_id) WHERE status IN ('pending','running') AND contact_id IS NOT NULL;

-- Atomic claim for enrichment jobs (same pattern as claim_due_enrollments).
CREATE OR REPLACE FUNCTION claim_enrichment_jobs(
  p_limit INT,
  p_claim UUID,
  p_lock_seconds INT DEFAULT 300
) RETURNS SETOF enrichment_jobs AS $$
BEGIN
  RETURN QUERY
  UPDATE enrichment_jobs j
     SET status = 'running', claim_id = p_claim,
         locked_until = NOW() + (p_lock_seconds || ' seconds')::interval,
         attempts = j.attempts + 1, updated_at = NOW()
   WHERE j.id IN (
     SELECT id FROM enrichment_jobs
      WHERE status = 'pending'
         OR (status = 'running' AND locked_until < NOW())   -- reclaim crashed jobs
      ORDER BY created_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING j.*;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- RLS on new tables (tenant isolation; service-role bypasses).
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['sequence_step_variants','icp_profiles','enrichment_jobs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
