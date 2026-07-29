-- ============================================================
-- marketing-agency-os :: consolidated schema push
-- Paste this whole file into Supabase Dashboard -> SQL Editor -> Run.
-- Order: 001 schema -> 003 reconcile -> 002 seed -> 004 multitenant.
-- Idempotent (IF NOT EXISTS / ON CONFLICT); safe to re-run except the
-- 002 contacts seed, which has no ON CONFLICT — run the seed block once.
-- Generated 2026-07-28T13:34:04Z
-- ============================================================

-- >>>>>>>>>> migrations/001_schema.sql >>>>>>>>>>

-- Marketing Agency OS Schema (source of truth)
-- Supabase PostgreSQL
-- NOTE: server code connects with the SERVICE ROLE key and bypasses RLS.
-- RLS is enabled with no anon policies, so the public anon key cannot read/write.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS brands (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  logo_url TEXT,
  active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  company TEXT,
  title TEXT,
  segment TEXT,
  score INT DEFAULT 0,
  status TEXT DEFAULT 'new',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contacts_brand_id ON contacts(brand_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_segment ON contacts(segment);

CREATE TABLE IF NOT EXISTS contact_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_contact_events_contact_id ON contact_events(contact_id);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  template_id TEXT,
  subject TEXT,
  body TEXT,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  brevo_id TEXT UNIQUE,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_contact_id ON email_campaigns(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);

CREATE TABLE IF NOT EXISTS content_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  platform TEXT NOT NULL,
  scheduled_for TIMESTAMPTZ,
  post_body TEXT NOT NULL,
  media_urls TEXT[],
  status TEXT DEFAULT 'draft',
  postiz_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_calendar_brand_id ON content_calendar(brand_id);
CREATE INDEX IF NOT EXISTS idx_content_calendar_platform ON content_calendar(platform);

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
CREATE INDEX IF NOT EXISTS idx_ad_campaigns_brand_id ON ad_campaigns(brand_id);

CREATE TABLE IF NOT EXISTS generated_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL,
  content TEXT NOT NULL,
  model_used TEXT,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending_approval',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_generated_content_contact_id ON generated_content(contact_id);
CREATE INDEX IF NOT EXISTS idx_generated_content_status ON generated_content(status);

CREATE TABLE IF NOT EXISTS social_engagement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  platform TEXT NOT NULL,
  post_id TEXT NOT NULL,
  commenter TEXT NOT NULL,
  comment_text TEXT NOT NULL,
  sentiment TEXT DEFAULT 'neutral',
  response_status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_engagement_platform ON social_engagement(platform);
CREATE INDEX IF NOT EXISTS idx_social_engagement_sentiment ON social_engagement(sentiment);

-- Hermes automation: sequence definitions + a durable job queue (no setTimeout on serverless)
CREATE TABLE IF NOT EXISTS hermes_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brand_id TEXT NOT NULL REFERENCES brands(id),
  name TEXT NOT NULL,
  trigger TEXT NOT NULL,
  steps JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hermes_sequences_brand_id ON hermes_sequences(brand_id);

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

-- Atomic score bump used by Hermes update_score action
CREATE OR REPLACE FUNCTION increment_contact_score(contact_id UUID, increment INT)
RETURNS void AS $$
  UPDATE contacts SET score = COALESCE(score, 0) + increment, updated_at = NOW()
  WHERE id = contact_id;
$$ LANGUAGE sql;

-- Lock the database down: enable RLS everywhere, define no anon policies.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users','brands','contacts','contact_events','email_campaigns',
    'content_calendar','ad_campaigns','generated_content','social_engagement',
    'hermes_sequences','hermes_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- >>>>>>>>>> migrations/003_reconcile.sql >>>>>>>>>>

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

-- >>>>>>>>>> migrations/002_seed.sql >>>>>>>>>>

INSERT INTO brands (id, name, logo_url, active) VALUES
('rentahub', 'Rentahub', 'https://example.com/rentahub.png', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Segments constrained to the app's Segment union:
-- investor | vc | angel | founder | media | partner | other
INSERT INTO contacts (brand_id, name, email, company, title, segment, score) VALUES
('rentahub', 'John Doe', 'john@example.com', 'TechVentures Inc', 'CEO', 'investor', 85),
('rentahub', 'Jane Smith', 'jane@example.com', 'VC Funds LLC', 'Partner', 'vc', 92),
('rentahub', 'Bob Johnson', 'bob@example.com', 'Angel Collective', 'Angel Investor', 'angel', 78),
('rentahub', 'Alice Brown', 'alice@example.com', 'Studio Productions', 'Producer', 'partner', 88),
('rentahub', 'Charlie Davis', 'charlie@example.com', 'Film Agency Co', 'Manager', 'partner', 72),
('rentahub', 'Diana Miller', 'diana@example.com', 'ContentHouse', 'Creator', 'media', 65),
('rentahub', 'Eve Wilson', 'eve@example.com', 'Global Studios', 'Director', 'founder', 84),
('rentahub', 'Frank Thomas', 'frank@example.com', 'Capital Partners', 'Founder', 'investor', 91),
('rentahub', 'Grace Lee', 'grace@example.com', 'Digital Ventures', 'VP Strategy', 'vc', 87),
('rentahub', 'Henry Martin', 'henry@example.com', 'Bootstrap Fund', 'Angel', 'angel', 75),
('rentahub', 'Ivy Chen', 'ivy@example.com', 'Media Group', 'Executive Producer', 'partner', 89),
('rentahub', 'Jack Anderson', 'jack@example.com', 'Creative Agency', 'Account Manager', 'partner', 70),
('rentahub', 'Kate Martinez', 'kate@example.com', 'YouTube Stars', 'Influencer', 'media', 68),
('rentahub', 'Leo Garcia', 'leo@example.com', 'Production House', 'Head of Production', 'founder', 86),
('rentahub', 'Mia Rodriguez', 'mia@example.com', 'Tech Investments', 'Principal', 'investor', 90),
('rentahub', 'Noah Taylor', 'noah@example.com', 'Venture Fund', 'Senior Partner', 'vc', 94),
('rentahub', 'Olivia White', 'olivia@example.com', 'New Angels', 'Angel Investor', 'angel', 76),
('rentahub', 'Peter Harris', 'peter@example.com', 'Indie Films', 'Producer', 'partner', 85),
('rentahub', 'Quinn Campbell', 'quinn@example.com', 'Marketing Firm', 'Director', 'partner', 73),
('rentahub', 'Rachel Green', 'rachel@example.com', 'Streaming Network', 'Content Creator', 'media', 69),
('rentahub', 'Sam Jackson', 'sam@example.com', 'Movie Studio', 'Exec Producer', 'founder', 88),
('rentahub', 'Tina Lopez', 'tina@example.com', 'Founders Club', 'Co-Founder', 'investor', 93),
('rentahub', 'Uma Patel', 'uma@example.com', 'Growth Fund', 'Managing Director', 'vc', 91),
('rentahub', 'Victor King', 'victor@example.com', 'Angel Network', 'Member', 'angel', 74),
('rentahub', 'Wendy Zhang', 'wendy@example.com', 'Production Co', 'Line Producer', 'partner', 83),
('rentahub', 'Xavier Scott', 'xavier@example.com', 'Brand Agency', 'Creative Lead', 'partner', 71),
('rentahub', 'Yara Moore', 'yara@example.com', 'Podcast Network', 'Host', 'media', 67),
('rentahub', 'Zoe Adams', 'zoe@example.com', 'Film Factory', 'Development', 'founder', 82),
('rentahub', 'Aaron Bell', 'aaron@example.com', 'Seed Fund', 'Founder', 'investor', 89),
('rentahub', 'Bella Stone', 'bella@example.com', 'Impact Fund', 'Partner', 'vc', 92);

-- >>>>>>>>>> migrations/004_multitenant.sql >>>>>>>>>>

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

INSERT INTO brands (id, name, active, account_id) VALUES
  ('filmops',      'FilmOps',       TRUE, '00000000-0000-0000-0000-0000000000b1'),
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


-- >>>>>>>>>> migrations/005_crm_objects.sql >>>>>>>>>>
-- 005_crm_objects.sql
-- Wave 1 of the CRM object model: Companies, Pipeline (Deals), Activities,
-- campaign membership, territories, and the data-governance rails
-- (audit log, contact merges, contact aliases).
-- Idempotent. Run after 001 -> 003 -> 002 -> 004.
-- Scoping convention (matches 004): account_id UUID NOT NULL, brand_id TEXT NULL
-- where NULL means account-wide. Admin/account-scoped; RLS enabled on every table.

-- ---------------------------------------------------------------------------
-- Core: Companies (Salesforce "Account") + contact -> company link
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,   -- null = account-wide
  name TEXT NOT NULL,
  domain TEXT,
  website TEXT,
  industry TEXT,
  size TEXT,                                               -- employee band
  linkedin_url TEXT,
  location TEXT,
  description TEXT,
  enriched JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_companies_account ON companies(account_id);
CREATE INDEX IF NOT EXISTS idx_companies_domain  ON companies(account_id, domain);

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- Sales pipeline: stages -> deals -> deal contact roles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pipeline_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,   -- null = account default pipeline
  name TEXT NOT NULL,
  position INT NOT NULL DEFAULT 0,
  is_won BOOLEAN NOT NULL DEFAULT FALSE,
  is_lost BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_stages_account ON pipeline_stages(account_id, position);

CREATE TABLE IF NOT EXISTS deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  primary_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  amount NUMERIC(14,2),
  currency TEXT DEFAULT 'USD',
  status TEXT NOT NULL DEFAULT 'open',                     -- open | won | lost
  probability INT,
  expected_close_date DATE,
  source TEXT,
  owner_email TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  closed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deals_account ON deals(account_id);
CREATE INDEX IF NOT EXISTS idx_deals_stage   ON deals(stage_id);
CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);

CREATE TABLE IF NOT EXISTS deal_contact_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  role TEXT,                                               -- decision-maker | champion | influencer | ...
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (deal_id, contact_id)
);

-- ---------------------------------------------------------------------------
-- Activities (polymorphic), Notes, Attachments
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  type TEXT NOT NULL,                                      -- task | call | meeting | email | event
  subject TEXT,
  body TEXT,
  status TEXT NOT NULL DEFAULT 'open',                     -- open | done
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  owner_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal    ON activities(deal_id);
CREATE INDEX IF NOT EXISTS idx_activities_account ON activities(account_id, status);

CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  author_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notes_contact ON notes(contact_id);

CREATE TABLE IF NOT EXISTS attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  filename TEXT,
  url TEXT NOT NULL,
  mime_type TEXT,
  size_bytes BIGINT,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  deal_id UUID REFERENCES deals(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Marketing: campaign membership (ad_campaigns is the campaign table)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campaign_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'targeted',                 -- targeted | sent | responded | converted
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (campaign_id, contact_id)
);

-- ---------------------------------------------------------------------------
-- Territory & Team: territories (partners deferred to Wave 2)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS territories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  region TEXT,
  country TEXT,
  owner_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- Data governance rails
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  actor_email TEXT,
  action TEXT NOT NULL,                                    -- import | enrich | merge | create | update | delete
  entity_type TEXT,                                       -- contact | company | deal | ...
  entity_id UUID,
  detail JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_audit_account ON audit_log(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_entity  ON audit_log(entity_type, entity_id);

CREATE TABLE IF NOT EXISTS contact_merges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  surviving_contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  merged_contact_id UUID,                                 -- absorbed record id (row itself is deleted)
  merged_snapshot JSONB,                                  -- full pre-merge row, nothing lost
  reason TEXT,
  actor_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_merges_surviving ON contact_merges(surviving_contact_id);

CREATE TABLE IF NOT EXISTS contact_aliases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  alias_type TEXT NOT NULL,                               -- email | name | phone | source_id
  alias_value TEXT NOT NULL,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contact_id, alias_type, alias_value)
);

-- ---------------------------------------------------------------------------
-- Enable RLS on every new table (server uses the service-role key; browser is gated)
-- ---------------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'companies','pipeline_stages','deals','deal_contact_roles',
    'activities','notes','attachments','campaign_members',
    'territories','audit_log','contact_merges','contact_aliases'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Seed: a default pipeline for the BDB account (account-wide, brand_id NULL).
-- Aligned to the DESIGN.md lead taxonomy so leads flow straight into deals.
-- Contacts/leads are NOT fabricated — only the stage scaffold.
-- ---------------------------------------------------------------------------
INSERT INTO pipeline_stages (account_id, brand_id, name, position, is_won, is_lost)
SELECT '00000000-0000-0000-0000-0000000000b1', NULL, s.name, s.position, s.is_won, s.is_lost
FROM (VALUES
  ('New',         1, FALSE, FALSE),
  ('Outreaching', 2, FALSE, FALSE),
  ('Replied',     3, FALSE, FALSE),
  ('Qualified',   4, FALSE, FALSE),
  ('Won',         5, TRUE,  FALSE),
  ('Lost',        6, FALSE, TRUE)
) AS s(name, position, is_won, is_lost)
WHERE NOT EXISTS (
  SELECT 1 FROM pipeline_stages p
  WHERE p.account_id = '00000000-0000-0000-0000-0000000000b1' AND p.brand_id IS NULL
);
