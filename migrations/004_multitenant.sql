-- 004_multitenant.sql
-- Adds the account (tenant) layer above ventures, per-account integrations,
-- and the module tables for enrichment, sequences, templates, inbox, campaign assets.
-- Idempotent. Run after 001 -> 002 -> 003.

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',        -- free | pro | enterprise
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS account_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',       -- owner | admin | member
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, email)
);

-- Ventures (brands) belong to an account.
ALTER TABLE brands ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Per-account integration connections (Apollo, Brevo, Meta, Google, social, email)
-- Credentials are stored as a Zo/host secret name reference OR encrypted blob,
-- never plaintext keys in a NEXT_PUBLIC-reachable table.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS integration_connections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                     -- apollo | brevo | resend | meta | google_ads | instagram | ...
  status TEXT NOT NULL DEFAULT 'disconnected',-- disconnected | connected | error
  secret_ref TEXT,                            -- name of the secret holding the key/token
  meta JSONB DEFAULT '{}'::jsonb,             -- account ids, page ids, scopes, last_error
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, provider)
);

-- ---------------------------------------------------------------------------
-- Leads: enrichment
-- ---------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'manual';        -- manual | apollo | import
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched JSONB;                        -- deep profile payload
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_status TEXT DEFAULT 'none'; -- none | pending | done | failed
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS fit_verdict TEXT;                      -- worth-it verdict (good_fit | maybe | skip)

-- Apollo search jobs (an ICP query that produced leads).
CREATE TABLE IF NOT EXISTS apollo_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  query JSONB NOT NULL,                        -- {industry, titles[], seniority[], location, size, keywords}
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | running | done | failed
  result_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Sequences (outreach) — replaces the impossible-on-serverless hermes model for
-- user-facing email sequences. hermes_* tables remain for automation triggers.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT NOT NULL REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email',       -- email
  is_active BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequence_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  step_order INT NOT NULL,
  delay_hours INT NOT NULL DEFAULT 0,          -- wait after previous step
  template_id UUID,                            -- optional message_templates ref
  subject TEXT,
  body TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sequence_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES sequences(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  current_step INT NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',       -- active | completed | paused | replied | bounced
  next_run_at TIMESTAMPTZ,                     -- drained by /api/hermes/tick
  last_event TEXT,                             -- sent | opened | replied | bounced
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (sequence_id, contact_id)
);

-- ---------------------------------------------------------------------------
-- Message templates
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS message_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,  -- null = account-wide
  name TEXT NOT NULL,
  category TEXT,                                -- cold_intro | follow_up | breakup | ...
  subject TEXT,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Inbox: connected mailboxes + unified messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,                       -- gmail | outlook | imap | brevo | resend
  address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  secret_ref TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, address)
);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email_account_id UUID REFERENCES email_accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  thread_id TEXT,
  direction TEXT NOT NULL DEFAULT 'inbound',    -- inbound | outbound
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body TEXT,
  is_read BOOLEAN DEFAULT FALSE,
  received_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Campaign assets (static images AND video) + AI analysis
-- ---------------------------------------------------------------------------
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS ai_managed BOOLEAN DEFAULT FALSE;  -- "let AI run it"

CREATE TABLE IF NOT EXISTS campaign_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'image',           -- image | video
  url TEXT NOT NULL,
  ai_analysis JSONB,                            -- quality/cleanup findings
  status TEXT NOT NULL DEFAULT 'raw',           -- raw | approved | cleaned | rejected
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content posts get an account_id too (white-label posting is per-account).
ALTER TABLE content_calendar ADD COLUMN IF NOT EXISTS account_id UUID REFERENCES accounts(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- RLS on every new table (tenant isolation). Service-role bypasses; browsers do not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'accounts','account_members','integration_connections','apollo_searches',
    'sequences','sequence_steps','sequence_enrollments','message_templates',
    'email_accounts','inbox_messages','campaign_assets'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Seed: our team as one enterprise account with our real ventures.
-- Leads are NOT fabricated here — they arrive via the Apollo connector once authorized.
-- ---------------------------------------------------------------------------
INSERT INTO accounts (id, name, plan)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'BDB Productions', 'enterprise')
ON CONFLICT (id) DO NOTHING;

INSERT INTO account_members (account_id, email, role)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'aifranckie101@gmail.com', 'owner')
ON CONFLICT (account_id, email) DO NOTHING;

-- FilmOps is a SEPARATE product and must never be seeded into LeadRail.
INSERT INTO brands (id, name, active, account_id) VALUES
  ('retentionrail','RetentionRail', TRUE, '00000000-0000-0000-0000-0000000000b1')
ON CONFLICT (id) DO UPDATE SET account_id = EXCLUDED.account_id;

-- Attach the pre-existing rentahub venture to our account.
UPDATE brands SET account_id = '00000000-0000-0000-0000-0000000000b1' WHERE id = 'rentahub';

-- Backfill account_id on existing venture-scoped rows.
UPDATE contacts       SET account_id = b.account_id FROM brands b WHERE contacts.brand_id = b.id AND contacts.account_id IS NULL;
UPDATE content_calendar SET account_id = b.account_id FROM brands b WHERE content_calendar.brand_id = b.id AND content_calendar.account_id IS NULL;
UPDATE ad_campaigns   SET account_id = b.account_id FROM brands b WHERE ad_campaigns.brand_id = b.id AND ad_campaigns.account_id IS NULL;

-- ============================================================
-- Lead status taxonomy calibration (DESIGN.md source of truth)
-- Canonical: new | outreaching | replied | qualified | dead
-- Idempotent remap of any legacy values from 001_schema.
-- ============================================================
UPDATE contacts SET status = 'outreaching' WHERE status = 'contacted';
UPDATE contacts SET status = 'replied'     WHERE status = 'engaged';
ALTER TABLE contacts ALTER COLUMN status SET DEFAULT 'new';
