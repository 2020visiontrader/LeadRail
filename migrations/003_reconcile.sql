-- 003_reconcile.sql
-- Idempotent upgrade for databases that already ran the ORIGINAL 001 schema
-- (engagement_score column, no notes, no hermes/ad tables, no RPC, no RLS).
-- Safe to run repeatedly and safe on a fresh 001 (source-of-truth) install.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- contacts: engagement_score -> score, add notes
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS score INT DEFAULT 0;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name='contacts' AND column_name='engagement_score') THEN
    UPDATE contacts SET score = COALESCE(score, engagement_score, 0);
    ALTER TABLE contacts DROP COLUMN engagement_score;
  END IF;
END $$;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();

CREATE TABLE IF NOT EXISTS ad_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  channel TEXT,
  budget NUMERIC DEFAULT 0,
  spend NUMERIC DEFAULT 0,
  start_date DATE,
  end_date DATE,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hermes_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS hermes_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES hermes_sequences(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  step_index INT NOT NULL DEFAULT 0,
  run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending',
  last_error TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hermes_jobs_due ON hermes_jobs(status, run_at);

CREATE OR REPLACE FUNCTION increment_contact_score(contact_id UUID, increment INT)
RETURNS void AS $$
  UPDATE contacts SET score = COALESCE(score, 0) + increment, updated_at = NOW()
  WHERE id = contact_id;
$$ LANGUAGE sql;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','brands','contacts','contact_events','email_campaigns',
    'content_calendar','ad_campaigns','generated_content','social_engagement',
    'hermes_sequences','hermes_jobs'
  ] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name=t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
    END IF;
  END LOOP;
END $$;
