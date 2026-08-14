-- 035_forms.sql — Web forms (lead-capture), per account.
--
-- A `form` is a named, embeddable lead-capture form: `fields` is a JSONB
-- array of {key, label, type, required} describing the input schema. Public
-- visitors POST to /api/public/forms/:id/submit with NO session — that route
-- derives account_id from the form row itself (see lib/forms/store.ts
-- getPublicForm/submitForm), never from the caller, so a submission can never
-- be attributed to the wrong tenant. Each submission is stored raw in
-- `form_submissions.data` and best-effort linked to an upserted contact.
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 029_journeys.sql / 030_segments.sql: account_id UUID NOT NULL, RLS enabled
-- with no anon policies — service-role bypasses, the app scopes every
-- read/write by account_id in code. Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS forms (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  fields       JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{key,label,type,required}]
  redirect_url TEXT,
  enabled      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_forms_account ON forms(account_id);

ALTER TABLE forms ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS form_submissions (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  form_id      UUID NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  account_id   UUID NOT NULL,
  data         JSONB NOT NULL DEFAULT '{}'::jsonb,
  contact_id   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_form_created ON form_submissions(form_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_form_submissions_account ON form_submissions(account_id);

ALTER TABLE form_submissions ENABLE ROW LEVEL SECURITY;
