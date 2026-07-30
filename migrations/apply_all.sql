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


-- >>>>>>>>>> migrations/006_crm_wave2.sql >>>>>>>>>>
-- 006_crm_wave2.sql
-- Wave 2 of the CRM object model: multi-org contact roles, partners, and the
-- service/support layer (cases, knowledge, entitlements). Completes the schema
-- specified in TARGET_SCHEMA.md. Idempotent. Run after 005.
-- RLS on every table; scoped account_id + brand_id (NULL brand = account-wide).

-- Contact ↔ many companies with a role (B2B multi-org affiliation)
CREATE TABLE IF NOT EXISTS contact_company_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role TEXT,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (contact_id, company_id)
);
CREATE INDEX IF NOT EXISTS idx_ccr_contact ON contact_company_roles(contact_id);
CREATE INDEX IF NOT EXISTS idx_ccr_company ON contact_company_roles(company_id);

-- Channel / partner relationships
CREATE TABLE IF NOT EXISTS partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT,                              -- referral | reseller | agency | vendor
  contact_email TEXT,
  status TEXT NOT NULL DEFAULT 'active',  -- active | inactive
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Support tickets
CREATE TABLE IF NOT EXISTS cases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'open',    -- open | pending | resolved | closed
  priority TEXT NOT NULL DEFAULT 'normal',-- low | normal | high | urgent
  assigned_to TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_cases_account ON cases(account_id, status);

-- Reusable support answers
CREATE TABLE IF NOT EXISTS knowledge_articles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT,
  tags TEXT[],
  status TEXT NOT NULL DEFAULT 'draft',   -- draft | published
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- SLA / support level per company
CREATE TABLE IF NOT EXISTS entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  company_id UUID REFERENCES companies(id) ON DELETE CASCADE,
  plan TEXT,
  sla_tier TEXT,
  seats INT,
  starts_at DATE,
  ends_at DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'contact_company_roles','partners','cases','knowledge_articles','entitlements'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- ===== 007_auth =====
-- Auth: password login for account members.
ALTER TABLE account_members ADD COLUMN IF NOT EXISTS password_hash TEXT;
ALTER TABLE account_members ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- ===== 008_seed_templates =====
-- 90 cold-email outreach templates for the account-wide library
-- (BDB Productions, brand_id null = usable across all ventures), 9 categories x 10.
-- Idempotent: unique on (account_id, name) so re-running this file is a no-op.
-- Supersedes any prior template seed: run TRUNCATE/DELETE for this account before
-- replaying if the table already has rows from an earlier, non-matching seed.
ALTER TABLE message_templates ADD CONSTRAINT IF NOT EXISTS message_templates_account_name_key UNIQUE (account_id, name);

INSERT INTO message_templates (account_id, name, category, subject, body) VALUES
('00000000-0000-0000-0000-0000000000b1', 'Value First Intro', 'intro', '3 retention insights for {{company}}', 'Hi {{name}},

I put together three retention insights based on what''s working for creator platforms like yours.

1. Most audience drop-off happens in the first 8 seconds, but the fix isn''t what most people think.
2. Mid-roll retention is the strongest predictor of brand deal renewal.
3. Cross platform benchmarking across YouTube, TikTok, and Instagram reveals gaps most teams miss.

Want me to send over the full breakdown?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Warm Intro for SaaS and Tech', 'intro', 'Quick question about {{company}}''s content analytics', 'Hi {{name}},

I''ve been following {{company}}''s work in the creator space, and it''s impressive traction.

We built RetentionRail to help creator focused platforms answer one question: why do viewers drop off, and what changes move the needle?

Would you be open to a 15 minute call next week? Happy to share what we''re seeing across the industry.

Best,
{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Direct Intro for Agencies and MCNs', 'intro', '{{company}} and RetentionRail: analytics partnership', 'Hey {{name}},

I noticed {{company}} manages a strong roster of creators. We''re working with MCNs to give their talent teams viewer retention data they currently don''t have, the kind that directly impacts brand deal rates and CPM.

Any interest in a 5 minute walkthrough tailored to your roster?

Cheers,
{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Talent Management', 'intro', 'How {{company}} could cut creator churn', 'Hi {{name}},

Managing a roster means brand deals live or die on retention data you can point to. RetentionRail gives talent teams a clean view of where each creator''s audience drops off, and why.

Worth 15 minutes to see it against your own roster?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Production Agencies', 'intro', 'Retention data for {{company}}''s slate', 'Hi {{name}},

Most production agencies still report engagement, not retention, which is what actually predicts renewal. RetentionRail plugs into your existing channels and surfaces drop-off points per episode or series.

Happy to show a live example from a similar slate.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Cold Intro for Enterprise Analytics Buyers', 'intro', 'RetentionRail for {{company}}''s analytics stack', 'Hi {{name}},

I know {{company}} already has an analytics stack. RetentionRail isn''t meant to replace it, it fills the one gap most platforms don''t cover well: second by second retention across YouTube, TikTok, and Instagram in one view.

Open to a technical walkthrough with your team?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Pain Point Intro Manual Reporting', 'intro', 'Still building retention reports by hand?', 'Hi {{name}},

A lot of teams we talk to are still pulling retention numbers into spreadsheets manually before every brand deal report. RetentionRail automates that, same data, a fraction of the time.

Want to see what it looks like for {{company}}?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Pain Point Intro Brand Deal Churn', 'intro', 'The metric brands actually renew on', 'Hi {{name}},

Brands are increasingly asking for retention curves, not just views, before renewing. If {{company}} can''t produce that on demand, it''s a real risk at renewal time.

RetentionRail generates it automatically. Worth a quick look?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Trigger Intro New Funding Announcement', 'intro', 'Congrats on the raise, {{name}}', 'Hi {{name}},

Saw the news about {{company}}''s round, congratulations. Scaling usually means the retention and reporting question gets harder before it gets easier.

RetentionRail is built for exactly that stage. Open to a short intro call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Trigger Intro Recent Creator Signing', 'intro', 'Saw {{company}}''s latest signing', 'Hi {{name}},

Congrats on the new signing, always a good moment to make sure your reporting can keep up with a growing roster.

RetentionRail scales retention analytics per creator without extra manual work on your team''s end. Want a quick look?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Case Study Follow Up', 'follow-up', 'Thought this {{company}} case study might resonate', 'Hi {{name}},

I came across a retention case study and it reminded me of {{company}}''s setup, specifically the part about reducing early drop-off by 34% with segmented benchmarks.

Here''s the link: [case study URL]

Would love to hear if anything in there aligns with what you''re working on.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Social Proof Follow Up', 'follow-up', 'Results from teams similar to {{company}}', 'Hey {{name}},

Since I last reached out, two teams similar to {{company}} started using RetentionRail to track audience retention across platforms.

One saw a 22% lift in average watch time within the first month. The other uses it for brand deal reporting.

If you''re curious, I can share the specifics.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Gentle Nudge', 'follow-up', 'Following up, {{name}}', 'Hi {{name}},

Just circling back on my note from earlier this week. I know things get busy.

If now isn''t the right time, happy to reconnect in a few weeks, just let me know either way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Data Point Hook', 'follow-up', 'One stat worth sharing, {{name}}', 'Hi {{name}},

One data point from our platform this week: creators over 250K subscribers are losing an average 18% more viewers in the first 15 seconds than six months ago.

If that''s relevant to {{company}}, happy to dig deeper together.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Competitor Benchmark', 'follow-up', 'How {{company}} compares on retention', 'Hi {{name}},

We can benchmark {{company}}''s retention curves against anonymized peers in your category. Most teams are surprised by where they actually stand.

Want me to run that comparison for you, no strings attached?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up One Question', 'follow-up', 'Quick one for {{name}}', 'Hi {{name}},

Is retention and drop-off reporting something {{company}} is actively trying to improve right now, or is it further down the list?

Either answer is useful, just trying to time this right.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Free Audit Offer', 'follow-up', 'Free retention audit for {{company}}', 'Hi {{name}},

Happy to run a free retention audit on two or three of {{company}}''s top performing videos, no commitment, just a look at where you''re losing viewers and why.

Send over the links whenever works.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Follow Up Resource Share', 'follow-up', 'A resource that might save you time', 'Hi {{name}},

Putting together our retention reporting checklist reminded me of our earlier conversation. I''ll send it over, it''s the exact framework we use internally before a brand deal renewal.

Let me know if it''s useful for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Second Follow Up', 'follow-up', 'Still worth a look?', 'Hi {{name}},

Following up once more, no pressure if the timing''s off. If retention analytics is on {{company}}''s radar for this quarter, I''d still love to show you what we''ve built.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Final Follow Up', 'follow-up', 'Last follow up from me, {{name}}', 'Hi {{name}},

This will be my last note on this for now. I don''t want to clutter your inbox. If priorities shift and retention reporting becomes relevant for {{company}}, just reply and I''ll pick this back up.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Permission to Close', 'break-up', 'Should I keep {{company}} on my radar?', 'Hey {{name}},

I want to be respectful of your inbox. If RetentionRail isn''t a fit for {{company}} right now, no hard feelings, just let me know and I''ll stop reaching out.

If it is on the roadmap, I''m happy to keep you updated as we roll out new features.

Either way, appreciate your time.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Final Check In', 'break-up', 'Closing the loop on {{company}}', 'Hi {{name}},

I''ve reached out a couple times and haven''t heard back, totally understand if the timing isn''t right.

I''ll stop here, but if retention analytics ever becomes a priority for {{company}}, the door''s always open.

Wishing you and the team the best.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Light Touch', 'break-up', 'Taking the hint, {{name}}', 'Hi {{name}},

I''ve reached out enough times that I don''t want to be another notification in your inbox. I''ll stop here, but if retention data ever becomes a priority for {{company}}, you know where to find me.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Door Open', 'break-up', 'Closing this out for now', 'Hi {{name}},

I''ll stop following up for now so I''m not adding noise. If anything changes on {{company}}''s side, the door''s open any time, no need to explain why it''s been a while.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up One Last Idea', 'break-up', 'One last thing before I go quiet', 'Hi {{name}},

Before I stop reaching out, here''s one framework we give every prospect regardless of outcome: track first 15 second drop-off weekly, it''s the single best early warning signal for renewal risk.

Hope it''s useful for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Timing Not Right', 'break-up', 'Understood on timing', 'Hi {{name}},

Sounds like this isn''t the right moment for {{company}}, and that''s completely fine. I''ll close this out on my end, feel free to reach out whenever the timing changes.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Reassign to Colleague', 'break-up', 'Right person for this?', 'Hi {{name}},

I may have the wrong person for this conversation. If someone else at {{company}} owns retention or creator analytics, I''d appreciate a pointer, otherwise I''ll close this thread.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Short and Direct', 'break-up', 'Closing the loop', 'Hi {{name}},

Haven''t heard back, so I''ll assume the timing isn''t right and stop here. Feel free to reach out if that changes.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Feedback Ask', 'break-up', 'Genuinely curious, {{name}}', 'Hi {{name}},

Before I close this out, genuinely curious if there''s a reason retention analytics isn''t a fit for {{company}} right now. Any quick feedback helps me not waste your time in future.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Break Up Long Term Opt In', 'break-up', 'Okay to check back in a few months?', 'Hi {{name}},

I''ll stop the regular outreach, but would it be alright if I checked back in a quarter or two, once {{company}}''s priorities may have shifted? Just say the word either way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Request Warm', 'referral', 'Do you know anyone who''d benefit from retention analytics?', 'Hi {{name}},

Thanks again for the conversation last month, really enjoyed hearing about {{company}}''s approach.

I''m currently connecting with more creator platforms and MCNs. If anyone in your network comes to mind who''s wrestling with audience retention or brand deal analytics, I''d be grateful for an intro.

No pressure at all.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Ask Post Demo', 'referral', 'Know other teams tackling retention?', 'Hi {{name}},

Glad the demo resonated. One quick ask: if you know other creator teams or agencies who''d find this useful, I''d love an introduction.

Happy to return the favor however I can.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Post Signup', 'referral', 'Know anyone else who''d benefit?', 'Hi {{name}},

Glad {{company}} is up and running on RetentionRail. If any other teams in your network are wrestling with retention reporting, I''d really appreciate an introduction.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Community or Event', 'referral', 'Great meeting you, {{name}}', 'Hi {{name}},

Really enjoyed our conversation earlier. If any other creator teams or MCNs from that event come to mind who might find retention analytics useful, I''d love an intro.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Incentive Offer', 'referral', 'A thank you for any intros', 'Hi {{name}},

If you introduce us to another creator team or MCN that ends up signing on, we''ll credit {{company}}''s account for a month, no strings attached. Just a small thank you for spreading the word.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Existing Customer Champion', 'referral', 'Would you be open to a quick intro?', 'Hi {{name}},

Given how well things have gone for {{company}} with RetentionRail, would you be open to introducing us to one or two other teams who might benefit similarly?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Investor Network', 'referral', 'Portfolio companies that might fit?', 'Hi {{name}},

If any companies in your portfolio manage creator relationships or run audience facing content, I''d love an introduction. RetentionRail tends to be a strong fit for that profile.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Partner Network', 'referral', 'Clients that might need this?', 'Hi {{name}},

If any of {{company}}''s clients are asking for better retention reporting, I''d welcome an introduction. Happy to make you look good in the process.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral Post Case Study', 'referral', 'Loved being featured, one small ask', 'Hi {{name}},

Thanks again for letting us feature {{company}} in our case study. If it resonates with anyone else in your network, I''d love an introduction, happy to return the favor.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Referral LinkedIn Comment Trigger', 'referral', 'Saw your comment on retention data', 'Hi {{name}},

Saw your comment about retention reporting pain points, sounds like something we solve daily at RetentionRail. If you know others discussing the same thing, feel free to point them my way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Weekly Insight Drop', 'nurture', 'Creator retention trend: what''s shifting this month', 'Hi {{name}},

Quick insight from our data this month: TikTok retention curves are flattening for creators over 500K followers, while YouTube Shorts retention is actually improving.

If {{company}} has creators in that range, this might be worth a look.

I send these out weekly, let me know if you''d like to be added.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Industry Report Share', 'nurture', 'Just published: Creator Retention Benchmarks Q3', 'Hi {{name}},

We just released our Q3 Creator Retention Benchmarks report, it covers YouTube, TikTok, and Instagram across 12 creator tiers.

Thought {{company}} might find the platform comparison section useful. Happy to send it over.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Feature Update Notification', 'nurture', 'New: cross platform retention dashboards', 'Hey {{name}},

Quick heads up, we just shipped cross platform retention dashboards. Creators can now compare their YouTube, TikTok, and Instagram retention curves side by side.

If {{company}} manages multi platform talent, this might save your team a lot of manual work.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Customer Spotlight', 'nurture', 'How one team cut drop-off by 22%', 'Hi {{name}},

A creator team similar to {{company}} used RetentionRail''s segmented benchmarks to cut early drop-off by 22% in six weeks. Happy to share exactly what they changed.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Webinar Invite', 'nurture', 'Webinar: retention benchmarks for creator teams', 'Hi {{name}},

We''re running a short webinar next week on reading retention curves for brand deal reporting. Thought it might be useful for {{company}}''s team, happy to send the link.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Comparison Guide', 'nurture', 'A quick platform comparison guide', 'Hi {{name}},

Put together a short guide comparing YouTube, TikTok, and Instagram retention patterns for mid size creators. Thought it would be a useful reference for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Quarterly Check In', 'nurture', 'Checking in for the new quarter', 'Hi {{name}},

As {{company}} plans out this quarter, wanted to flag that retention reporting tends to get harder right before renewal season. Happy to help you get ahead of it.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Roadmap Preview', 'nurture', 'What we''re shipping next', 'Hi {{name}},

Wanted to give {{company}} a preview of what''s coming: automated brand deal ready reports and creator level churn alerts, both shipping next month.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Milestone Announcement', 'nurture', 'We just crossed a milestone', 'Hi {{name}},

RetentionRail just crossed 50 creator platforms on the product, wanted to share since {{company}} has been part of the conversation along the way.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Nurture Educational Tip', 'nurture', 'A retention tip worth testing', 'Hi {{name}},

Quick tip: moving your strongest hook to the 3 second mark instead of the intro typically improves 15 second retention by 8 to 12 percent. Worth testing on {{company}}''s next upload.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Request Direct', 'demo', 'RetentionRail demo for {{company}}?', 'Hi {{name}},

Would a 20 minute walkthrough of RetentionRail be useful? I can tailor it to {{company}}''s creator portfolio, showing retention curves and drop-off points specific to your niche.

This week: Tuesday after 2pm or Thursday morning.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Team Onboarding', 'demo', 'Team demo: RetentionRail for {{company}}', 'Hi {{name}},

If your whole talent team would benefit from seeing RetentionRail in action, I''m happy to run a group session.

We can cover reading retention curves for brand deals, cross platform comparisons, and flagging at risk creator accounts.

30 minutes, I''ll adapt to whatever works for your team.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Executive Briefing', 'demo', 'A short executive level briefing?', 'Hi {{name}},

Happy to run a condensed, executive level version of the RetentionRail demo for {{company}}''s leadership, 15 minutes, focused on the business impact rather than the tooling.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Live Data Walkthrough', 'demo', 'Want to see {{company}}''s own data?', 'Hi {{name}},

Instead of a generic demo, I can pull a sample of {{company}}''s actual public content into RetentionRail and walk through the real retention curves live.

Want me to set that up?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Post Trial Follow Up', 'demo', 'How''s the trial going, {{name}}?', 'Hi {{name}},

Wanted to check in on how the trial has been for {{company}} so far, happy to jump on a call to answer questions or dig into anything specific in the data.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Reschedule Offer', 'demo', 'No worries, want to reschedule?', 'Hi {{name}},

No problem at all if the original time didn''t work. Let me know a few slots that suit {{company}}''s team and I''ll get something on the calendar.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo No Show Recovery', 'demo', 'Missed you earlier, still happy to connect', 'Hi {{name}},

Looks like we missed each other for the scheduled call. Totally understand things come up, let me know a better time and I''ll rebook for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Competitive Comparison', 'demo', 'Evaluating a few analytics tools?', 'Hi {{name}},

If {{company}} is comparing a few retention and analytics tools side by side, happy to set up RetentionRail so you can benchmark it directly against the others on the same content.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Free Pilot Offer', 'demo', '30 day pilot for {{company}}', 'Hi {{name}},

Would a free 30 day pilot help {{company}} evaluate RetentionRail properly before any commitment? I can get it set up on your top channels this week.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Demo Custom ROI Model', 'demo', 'A custom ROI model for {{company}}', 'Hi {{name}},

I can build a quick ROI model specific to {{company}}''s roster size and average deal value, so the demo isn''t abstract, it''s tied to numbers your team already tracks.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Pitch Cold', 'investor', 'RetentionRail: creator analytics investment', 'Hi {{name}},

I know you focus on creator economy investments. RetentionRail is a creator analytics platform that helps MCNs and agencies understand exactly where audiences drop off, and what to do about it.

We''re seeing strong traction with mid market creator platforms, 30 plus customers and a $180K ARR pipeline in Q3.

Would you be open to a brief intro call to discuss?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Referral from Founder', 'investor', '{{referrer}} suggested I reach out', 'Hi {{name}},

{{referrer}} suggested I connect with you about RetentionRail. They thought our creator analytics platform would be relevant to your portfolio.

We help creator platforms and MCNs understand audience retention, which directly impacts CPM, brand deal rates, and churn.

Would you have 15 minutes next week?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Update Pipeline', 'investor', 'RetentionRail Q3 pipeline update', 'Hi {{name}},

Quick update on RetentionRail: 30 active pilots across MCNs and creator platforms, $1.85M in pipeline with an average deal size of $110K, and we just shipped cross platform dashboards.

Happy to walk through the latest deck if you''d like a refresher.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Warm Intro via Portfolio Company', 'investor', '{{referrer}} suggested we connect', 'Hi {{name}},

{{referrer}} mentioned you invest in creator economy infrastructure and thought RetentionRail would be relevant given our traction with MCNs and analytics platforms.

Open to a short intro call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Traction Milestone', 'investor', 'A quick milestone update', 'Hi {{name}},

Wanted to flag a milestone: RetentionRail just crossed 50 active creator platforms with strong expansion revenue from existing accounts. Happy to share the details if useful.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Follow On Round', 'investor', 'Opening up our next round soon', 'Hi {{name}},

We''re starting conversations ahead of our next round and thought you''d want an early look given your focus on creator economy tools. Would a brief call make sense?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Market Sizing Angle', 'investor', 'The retention analytics gap', 'Hi {{name}},

Most creator platforms report views and engagement, but almost none report retention well, a gap we think is worth several hundred million as MCNs and platforms professionalize reporting.

Would love your take.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Thesis Fit', 'investor', 'Might fit your thesis on creator infrastructure', 'Hi {{name}},

Given your public writing on creator economy infrastructure, RetentionRail''s approach to retention analytics for MCNs seemed like a natural fit to share.

Open to trading notes?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Post Meeting Recap', 'investor', 'Thanks for the time, {{name}}', 'Hi {{name}},

Thanks again for the conversation. As discussed, I''ll follow up with the deck and the customer references, let me know if anything else would help as you evaluate.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Investor Monthly Update', 'investor', 'Monthly update: RetentionRail', 'Hi {{name}},

Quick monthly update: ARR up 14% month over month, two new MCN pilots signed, and our cross platform dashboard shipped ahead of schedule. Happy to go deeper on any of it.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partnership Exploration', 'partner', '{{company}} and RetentionRail partnership', 'Hi {{name}},

I''ve been looking at {{company}}''s creator ecosystem and think there could be a natural partnership with RetentionRail.

Our retention analytics could add value to your creator clients, and your distribution could help us reach more teams.

Worth exploring over a call?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Integration Partner Pitch', 'partner', 'API integration: RetentionRail and {{company}}', 'Hi {{name}},

We''re exploring integration partners and {{company}} came up as a strong fit. RetentionRail''s retention data could feed directly into your platform, giving your users real time audience drop-off insights.

Our API is ready, would love to explore a pilot integration.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Co Marketing Proposal', 'partner', 'Co marketing idea for {{company}} and RetentionRail', 'Hi {{name}},

Our audiences overlap closely, creator teams and MCNs. Would {{company}} be open to a joint webinar or content piece on retention analytics for the creator economy?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Reseller Program', 'partner', 'Reseller opportunity with RetentionRail', 'Hi {{name}},

We''re building out a reseller program for agencies like {{company}} that already manage analytics relationships with creator clients. Worth a conversation about terms?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Data Sharing Agreement', 'partner', 'A data sharing partnership?', 'Hi {{name}},

RetentionRail''s retention data paired with {{company}}''s platform metrics could give both our users a much fuller picture. Open to exploring a data sharing agreement?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Event Co Sponsorship', 'partner', 'Co sponsoring an upcoming event?', 'Hi {{name}},

We''re evaluating sponsorships for the next creator economy conference and thought {{company}} might want to split the booth and content slot with us. Interested?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Agency Referral Program', 'partner', 'Referral program for agencies like {{company}}', 'Hi {{name}},

We''re setting up a formal referral arrangement for agencies that regularly work with creator platforms. Would {{company}} want to be one of the first partners?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Marketplace Listing', 'partner', 'Listing RetentionRail in your marketplace', 'Hi {{name}},

Would {{company}} be open to listing RetentionRail in your integrations marketplace? Our retention data would give your users a feature they currently have to source elsewhere.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Joint Case Study', 'partner', 'A joint case study, {{name}}?', 'Hi {{name}},

Given how well the integration between {{company}} and RetentionRail has worked, would you be open to co-authoring a case study? Good exposure for both of us.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Partner Renewal Check In', 'partner', 'Checking in on the partnership', 'Hi {{name}},

As we come up on renewal for the {{company}} partnership, wanted to check in on how things have gone and whether there''s room to expand the integration further.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Long Time No Talk', 'reengagement', 'Been a while, {{name}}', 'Hi {{name}},

It''s been a while since we last talked about retention analytics for {{company}}. A lot has changed on our end since then, worth a quick reconnect?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement What Changed Since', 'reengagement', 'What''s changed for {{company}} since we last spoke', 'Hi {{name}},

Curious what''s changed for {{company}}''s creator strategy since we last spoke. Happy to share what''s new on our side too if it''s useful timing.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement New Feature Trigger', 'reengagement', 'The feature you asked about is live', 'Hi {{name}},

You''d mentioned wanting cross platform comparisons the last time we spoke, that''s live now. Worth taking another look for {{company}}?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Reintroduction After Silence', 'reengagement', 'Reintroducing myself, {{name}}', 'Hi {{name}},

It''s been long enough that a proper reintroduction seems fair. I''m still with RetentionRail, and we''ve grown a lot since we last connected. Open to catching up?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Win Back Offer', 'reengagement', 'A one time offer to come back', 'Hi {{name}},

We''d love to have {{company}} take another look at RetentionRail. Happy to offer a free onboarding month if now''s a better time than before.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Industry Shift Angle', 'reengagement', 'The retention conversation has shifted', 'Hi {{name}},

Retention reporting has become table stakes for brand deals since we last spoke. Thought it was worth flagging in case it changes the calculus for {{company}}.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Check Current Priorities', 'reengagement', 'Still not the right time?', 'Hi {{name}},

Just checking whether retention analytics has moved up {{company}}''s priority list since we last spoke, or if it''s still not the right time.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Personal Note', 'reengagement', 'Good to have met you at the event', 'Hi {{name}},

Good connecting in person a while back, realized I never properly followed up. Still think RetentionRail could be a fit for {{company}}. Worth a quick call now?

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Referral Reconnect', 'reengagement', '{{referrer}} reminded me to follow up', 'Hi {{name}},

{{referrer}} mentioned {{company}} recently and it reminded me we hadn''t reconnected in a while. Wanted to see if retention reporting is on your radar again.

{{sender}}'),
('00000000-0000-0000-0000-0000000000b1', 'Reengagement Final Note', 'reengagement', 'Last note before I archive this thread', 'Hi {{name}},

I''ll archive this thread after this note unless something''s changed for {{company}}. If retention analytics becomes relevant again, just reply and I''ll pick it right back up.

{{sender}}')
ON CONFLICT (account_id, name) DO NOTHING;


-- >>>>>>>>>> migrations/009_outreach_hardening.sql >>>>>>>>>>

-- 009_outreach_hardening.sql
-- Phase A: outreach-engine correctness & deliverability.
-- Closes baseline gaps #1–#5: suppression, atomic claim, reply-stop,
-- open/click tracking, per-mailbox/account send caps. Idempotent.
-- Run after 001 -> 003 -> 002 -> 004 (and 005..008).

-- ---------------------------------------------------------------------------
-- #1 Suppression / blocklist (account-scoped). Enforced in every send path.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT,                                  -- exact address (lowercased) OR null when domain-level
  domain TEXT,                                 -- e.g. "example.com" — suppresses all addresses at the domain
  reason TEXT NOT NULL DEFAULT 'manual',       -- manual | unsubscribe | hard_bounce | complaint | spam
  source TEXT,                                 -- newsletter | sequence | webhook | import
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppressions_account_email
  ON suppressions(account_id, email) WHERE email IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_suppressions_account_domain
  ON suppressions(account_id, domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_suppressions_account ON suppressions(account_id);

-- ---------------------------------------------------------------------------
-- #3 Atomic enrollment claim + #2 reply-stop columns.
-- ---------------------------------------------------------------------------
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS claim_id UUID;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS thread_id TEXT;         -- last outbound thread, for reply matching
ALTER TABLE sequence_enrollments ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_enrollments_due
  ON sequence_enrollments(status, next_run_at) WHERE status = 'active';

-- Atomically claim up to p_limit due enrollments for one tick invocation.
-- FOR UPDATE SKIP LOCKED guarantees two concurrent ticks never grab the same
-- row (fixes gap #4 double-send). Claimed rows are stamped with claim_id and a
-- short lock window so a crashed tick self-heals when locked_until elapses.
CREATE OR REPLACE FUNCTION claim_due_enrollments(
  p_limit INT,
  p_claim UUID,
  p_lock_seconds INT DEFAULT 300
) RETURNS SETOF sequence_enrollments AS $$
BEGIN
  RETURN QUERY
  UPDATE sequence_enrollments e
     SET claim_id = p_claim,
         locked_until = NOW() + make_interval(secs => p_lock_seconds)
   WHERE e.id IN (
     SELECT id FROM sequence_enrollments
      WHERE status = 'active'
        AND next_run_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY next_run_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING e.*;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #4 Open/click tracking. Append-only events + per-step funnel counters.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS email_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  enrollment_id UUID REFERENCES sequence_enrollments(id) ON DELETE SET NULL,
  step_id UUID REFERENCES sequence_steps(id) ON DELETE SET NULL,
  type TEXT NOT NULL,                          -- open | click
  url TEXT,                                    -- for click
  ua TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_email_events_contact ON email_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_events_enrollment ON email_events(enrollment_id);

ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS sent_count INT NOT NULL DEFAULT 0;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS open_count INT NOT NULL DEFAULT 0;
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS click_count INT NOT NULL DEFAULT 0;

-- Atomic per-step counter bump (open_count | click_count | sent_count).
-- Column name is validated against an allowlist to avoid dynamic-SQL injection.
CREATE OR REPLACE FUNCTION increment_step_counter(p_step UUID, p_col TEXT)
RETURNS VOID AS $$
BEGIN
  IF p_col NOT IN ('sent_count', 'open_count', 'click_count') THEN
    RAISE EXCEPTION 'invalid counter column: %', p_col;
  END IF;
  EXECUTE format('UPDATE sequence_steps SET %I = %I + 1 WHERE id = $1', p_col, p_col)
    USING p_step;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #5 Deliverability caps. Per-mailbox daily cap + per-account daily cap.
-- ---------------------------------------------------------------------------
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS daily_cap INT NOT NULL DEFAULT 200;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS sent_today INT NOT NULL DEFAULT 0;
ALTER TABLE email_accounts ADD COLUMN IF NOT EXISTS unlock_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS daily_send_cap INT NOT NULL DEFAULT 500;

-- Count today's outbound sends for an account (through the contact join, since
-- email_campaigns predates the account_id column). Used to enforce daily caps.
CREATE OR REPLACE FUNCTION account_sent_today(p_account UUID) RETURNS INT AS $$
  SELECT COUNT(*)::INT
    FROM email_campaigns ec
    JOIN contacts c ON c.id = ec.contact_id
   WHERE c.account_id = p_account
     AND ec.status IN ('sent', 'opened', 'bounced')
     AND ec.sent_at >= date_trunc('day', NOW());
$$ LANGUAGE sql STABLE;

-- RLS on new tables (service-role bypasses; browsers cannot read).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['suppressions','email_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- <<<<<<<<<< migrations/009_outreach_hardening.sql <<<<<<<<<<


-- >>>>>>>>>> migrations/010_data_model_depth.sql >>>>>>>>>>

-- 010_data_model_depth.sql
-- Phase B: data-model depth (Twenty/GHL structural patterns).
-- Items: 11 custom_fields + tags, 9 unified timeline, 12 soft-delete,
-- 13 full-text search, 10 polymorphic note/task targets. Idempotent.
-- Run after 001..009.

-- ---------------------------------------------------------------------------
-- #11 Flexible fields (JSONB) + tags. custom_fields avoids Twenty's runtime
--     metadata engine while giving per-record extensibility.
-- ---------------------------------------------------------------------------
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS custom_fields JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (account_id, name)
);
CREATE TABLE IF NOT EXISTS contact_tags (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (contact_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_contact_tags_tag ON contact_tags(tag_id);

-- ---------------------------------------------------------------------------
-- #9 Unified timeline (Twenty timelineActivity). Append-only, any entity.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timeline_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,                 -- contact | company | deal
  entity_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,  -- convenience for contact feeds
  type TEXT NOT NULL,                        -- note | activity | email_sent | email_open | email_click | status_change | ...
  title TEXT,
  body TEXT,
  meta JSONB DEFAULT '{}'::jsonb,
  actor_email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_timeline_entity  ON timeline_activities(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_contact ON timeline_activities(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_timeline_account ON timeline_activities(account_id, created_at DESC);

-- Backfill from the existing contact_events seed (resolve account via contact).
INSERT INTO timeline_activities (account_id, entity_type, entity_id, contact_id, type, title, meta, created_at)
SELECT c.account_id, 'contact', ce.contact_id, ce.contact_id, ce.event_type, ce.event_type, COALESCE(ce.event_data, '{}'::jsonb), ce.created_at
  FROM contact_events ce
  JOIN contacts c ON c.id = ce.contact_id
 WHERE c.account_id IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM timeline_activities t
      WHERE t.contact_id = ce.contact_id AND t.type = ce.event_type AND t.created_at = ce.created_at
   );

-- ---------------------------------------------------------------------------
-- #12 Soft delete + purge (Twenty deletedAt). Reads filter deleted_at IS NULL.
-- ---------------------------------------------------------------------------
ALTER TABLE contacts  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE deals     ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_contacts_live  ON contacts(account_id)  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_companies_live ON companies(account_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_deals_live     ON deals(account_id)     WHERE deleted_at IS NULL;

-- Hard-purge rows soft-deleted longer than p_days ago (trash cron).
CREATE OR REPLACE FUNCTION purge_soft_deleted(p_days INT DEFAULT 30) RETURNS INT AS $$
DECLARE n INT := 0; m INT;
BEGIN
  DELETE FROM contacts  WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => p_days); GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  DELETE FROM companies WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => p_days); GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  DELETE FROM deals     WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - make_interval(days => p_days); GET DIAGNOSTICS m = ROW_COUNT; n := n + m;
  RETURN n;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- #13 Full-text search (Twenty tsvector). Generated columns + GIN.
-- ---------------------------------------------------------------------------
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    coalesce(name,'') || ' ' || coalesce(email,'') || ' ' ||
    coalesce(company,'') || ' ' || coalesce(title,'') || ' ' || coalesce(notes,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_contacts_tsv ON contacts USING GIN (search_tsv);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS search_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english',
    coalesce(name,'') || ' ' || coalesce(domain,'') || ' ' ||
    coalesce(industry,'') || ' ' || coalesce(description,''))) STORED;
CREATE INDEX IF NOT EXISTS idx_companies_tsv ON companies USING GIN (search_tsv);

-- ---------------------------------------------------------------------------
-- #10 Polymorphic note/task targets (Twenty noteTarget/taskTarget). Additive:
--     the fixed contact_id/company_id/deal_id columns keep working; these join
--     tables let one note/task attach to many records.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS note_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,                 -- contact | company | deal
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (note_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_note_targets ON note_targets(target_type, target_id);

CREATE TABLE IF NOT EXISTS task_targets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_id UUID NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL,
  target_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (activity_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_task_targets ON task_targets(target_type, target_id);

-- Backfill targets from the existing fixed FKs.
INSERT INTO note_targets (note_id, target_type, target_id)
SELECT id, 'contact', contact_id FROM notes WHERE contact_id IS NOT NULL
UNION ALL SELECT id, 'company', company_id FROM notes WHERE company_id IS NOT NULL
UNION ALL SELECT id, 'deal', deal_id FROM notes WHERE deal_id IS NOT NULL
ON CONFLICT (note_id, target_type, target_id) DO NOTHING;

INSERT INTO task_targets (activity_id, target_type, target_id)
SELECT id, 'contact', contact_id FROM activities WHERE contact_id IS NOT NULL
UNION ALL SELECT id, 'company', company_id FROM activities WHERE company_id IS NOT NULL
UNION ALL SELECT id, 'deal', deal_id FROM activities WHERE deal_id IS NOT NULL
ON CONFLICT (activity_id, target_type, target_id) DO NOTHING;

-- RLS on new tables.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['tags','contact_tags','timeline_activities','note_targets','task_targets'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- <<<<<<<<<< migrations/010_data_model_depth.sql <<<<<<<<<<

-- >>>>>>>>>> migrations/011_typed_sequencing.sql >>>>>>>>>>
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
-- <<<<<<<<<< migrations/011_typed_sequencing.sql <<<<<<<<<<

-- >>>>>>>>>> migrations/012_platform.sql >>>>>>>>>>
-- 012_platform.sql
-- Phase D: platform / integration surface.
-- Items 14 (unified conversations), 18 (signed outbound webhooks),
-- 19 (data-driven automations engine). Item 15 (GHL location id) is code/config
-- only and needs no schema (stored in integration_connections.meta.locationId).
-- Item 20 (pgvector qualifier) is deferred. Safe after 004..011. Idempotent.

-- ===========================================================================
-- #14 Unified conversations — generalize inbox_messages into a channel-agnostic
-- thread model (email today; sms/social/whatsapp later). inbox_messages stays as
-- the email ingest source of truth; conversations mirror it plus outbound sends.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email',        -- email | sms | social | whatsapp
  external_thread_id TEXT,                       -- provider thread id (email thread_id, etc.)
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'open',           -- open | closed | snoozed
  last_direction TEXT,                           -- inbound | outbound
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  unread_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
-- One thread per (account, channel, external_thread_id) when a thread id exists.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_thread_uidx
  ON conversations (account_id, channel, external_thread_id)
  WHERE external_thread_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS conversations_account_idx ON conversations (account_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS conversations_contact_idx ON conversations (contact_id);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  channel TEXT NOT NULL DEFAULT 'email',
  direction TEXT NOT NULL DEFAULT 'inbound',      -- inbound | outbound
  from_addr TEXT,
  to_addr TEXT,
  subject TEXT,
  body TEXT,
  external_id TEXT,                                -- provider message id (dedup)
  meta JSONB DEFAULT '{}'::jsonb,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS conv_messages_conv_idx ON conversation_messages (conversation_id, sent_at);
CREATE UNIQUE INDEX IF NOT EXISTS conv_messages_external_uidx
  ON conversation_messages (account_id, channel, external_id)
  WHERE external_id IS NOT NULL;

-- Backfill: one conversation per (account, thread key) from existing inbox_messages,
-- then one conversation_message per inbox row. Thread key = thread_id, else contact,
-- else the message id itself (singleton thread). Idempotent via the unique indexes.
DO $$
DECLARE r RECORD; conv_id UUID; thread_key TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'inbox_messages') THEN
    FOR r IN SELECT * FROM inbox_messages ORDER BY received_at ASC LOOP
      thread_key := COALESCE(NULLIF(r.thread_id, ''), 'imsg:' || r.id::text);
      -- find-or-create the conversation for this thread key
      SELECT id INTO conv_id FROM conversations
        WHERE account_id = r.account_id AND channel = 'email' AND external_thread_id = thread_key
        LIMIT 1;
      IF conv_id IS NULL THEN
        INSERT INTO conversations (account_id, contact_id, channel, external_thread_id, subject,
                                   last_direction, last_message_at, unread_count)
        VALUES (r.account_id, r.contact_id, 'email', thread_key, r.subject,
                r.direction, r.received_at, CASE WHEN r.is_read THEN 0 ELSE 1 END)
        RETURNING id INTO conv_id;
      END IF;
      -- mirror the message (skip if already backfilled)
      IF NOT EXISTS (SELECT 1 FROM conversation_messages
                       WHERE account_id = r.account_id AND channel = 'email'
                         AND external_id = ('imsg:' || r.id::text)) THEN
        INSERT INTO conversation_messages (account_id, conversation_id, contact_id, channel, direction,
                                           from_addr, to_addr, subject, body, external_id, is_read, sent_at)
        VALUES (r.account_id, conv_id, r.contact_id, 'email', r.direction,
                r.from_addr, r.to_addr, r.subject, r.body, 'imsg:' || r.id::text, r.is_read, r.received_at);
      END IF;
    END LOOP;
  END IF;
END $$;

-- ===========================================================================
-- #19 Automations engine (trigger / filter / action) — the product surface that
-- supersedes the hardcoded hermes trigger conditions. An automation fires on a
-- named trigger, evaluates a filter (JSON conditions) against the event context,
-- and runs an action. Runs are logged for observability.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trigger JSONB NOT NULL DEFAULT '{}'::jsonb,     -- { type, config }
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { match: 'all'|'any', conditions: [{field, op, value}] }
  action JSONB NOT NULL DEFAULT '{}'::jsonb,      -- { type, config }
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  run_count INT NOT NULL DEFAULT 0,
  last_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automations_trigger_idx
  ON automations (account_id, (trigger->>'type')) WHERE is_active;

CREATE TABLE IF NOT EXISTS automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  automation_id UUID NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  trigger_type TEXT,
  context JSONB DEFAULT '{}'::jsonb,
  matched BOOLEAN,
  outcome TEXT,                                    -- ran | skipped | error
  detail TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS automation_runs_idx ON automation_runs (automation_id, created_at DESC);

-- ===========================================================================
-- #6 (cont.) Branch step config — Phase C stored `branch` as a no-op skip. The
-- rules engine now evaluates a step's `config` ({match, conditions[], jumpTo,
-- else}) to conditionally jump within a sequence. `config` also carries per-step
-- options for other step types going forward. Backward-compatible (default {}).
-- ===========================================================================
ALTER TABLE sequence_steps ADD COLUMN IF NOT EXISTS config JSONB DEFAULT '{}'::jsonb;

-- ===========================================================================
-- #18 Signed outbound webhooks — customer registers endpoints; platform emits
-- events to a durable delivery queue, drained by the tick with HMAC-signed POSTs
-- and bounded retries + exponential backoff.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,                            -- HMAC signing secret (shown once on create)
  events TEXT[] NOT NULL DEFAULT '{}',             -- subscribed event names; empty = all
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_status INT,
  last_delivery_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_account_idx ON webhook_endpoints (account_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_id UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'pending',          -- pending | delivered | failed
  attempts INT NOT NULL DEFAULT 0,
  response_status INT,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ DEFAULT NOW(),
  claim_id UUID,
  locked_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'failed');

-- Atomic claim for the delivery worker (mirrors claim_due_enrollments).
CREATE OR REPLACE FUNCTION claim_webhook_deliveries(
  p_limit INT,
  p_claim UUID,
  p_lock_seconds INT DEFAULT 120
) RETURNS SETOF webhook_deliveries AS $$
BEGIN
  RETURN QUERY
  UPDATE webhook_deliveries d
     SET claim_id = p_claim,
         locked_until = NOW() + (p_lock_seconds || ' seconds')::interval,
         attempts = d.attempts + 1
   WHERE d.id IN (
     SELECT id FROM webhook_deliveries
      WHERE status IN ('pending', 'failed')
        AND next_attempt_at <= NOW()
        AND (locked_until IS NULL OR locked_until < NOW())
      ORDER BY next_attempt_at ASC
      LIMIT p_limit
      FOR UPDATE SKIP LOCKED
   )
  RETURNING d.*;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- RLS parity with the rest of the schema (service-role bypasses; app scopes).
-- ===========================================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations','conversation_messages','automations',
                           'automation_runs','webhook_endpoints','webhook_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;
-- <<<<<<<<<< migrations/012_platform.sql <<<<<<<<<<
