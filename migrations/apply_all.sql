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


-- ===== 021_meta_ads.sql =====
-- 021_meta_ads.sql — Live Meta Marketing API hierarchy on top of ad_campaigns.
-- Campaign row stays the source of truth for the UI; Meta is source of truth for spend.
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS meta_campaign_id   TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS meta_ad_account_id TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS objective          TEXT;
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS meta_status        TEXT;   -- PAUSED | ACTIVE | ARCHIVED (mirror of Meta)
ALTER TABLE ad_campaigns ADD COLUMN IF NOT EXISTS last_synced_at     TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS ad_sets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  meta_adset_id TEXT,
  name TEXT NOT NULL,
  daily_budget NUMERIC,
  optimization_goal TEXT,
  billing_event TEXT,
  targeting JSONB,
  meta_status TEXT DEFAULT 'PAUSED',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS ads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ad_set_id UUID NOT NULL REFERENCES ad_sets(id) ON DELETE CASCADE,
  campaign_id UUID NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
  meta_ad_id TEXT,
  meta_creative_id TEXT,
  asset_id UUID,
  name TEXT NOT NULL,
  meta_status TEXT DEFAULT 'PAUSED',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ad_sets_campaign ON ad_sets(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ads_campaign ON ads(campaign_id);

-- ============================================================================
-- 022_agent_conversations.sql — Operator-copilot memory substrate.
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id TEXT REFERENCES brands(id),
  title TEXT,
  transcript JSONB,
  carryover JSONB,
  token_estimate INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_conversations_account ON agent_conversations(account_id);

CREATE TABLE IF NOT EXISTS agent_memory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  subject TEXT,
  predicate TEXT,
  object TEXT,
  fact TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_account ON agent_memory(account_id);

-- ============================================================================
-- 023_ai_providers.sql — Provider/model registry + routing + usage (A0).
-- Must precede 024 (personas.model_id FK -> ai_models).
-- ============================================================================
-- 023_ai_providers.sql — Configurable AI provider/model registry, per account.
--
-- Replaces (additively — the hardcoded ladder in lib/ai/router.ts stays as the
-- zero-config fallback) the fixed Zo Ask -> OpenCode -> NIM chain with an
-- account-owned registry: providers (credentials + endpoint), models (per
-- provider, tiered + tagged), and routing (which model is active + the ordered
-- fallback chain). API keys are stored encrypted (see lib/ai/crypto.ts) — this
-- migration only defines the column; encryption happens in application code
-- with AES-256-GCM under AI_VAULT_KEY, never in SQL.
--
-- Scoping convention matches 004/005: account_id UUID NOT NULL. brand_id is
-- intentionally omitted from ai_providers/ai_models — provider credentials are
-- an account-level resource (like integration_connections), not per-venture.
-- ai_routing is account-wide too, since "which model answers" is an account
-- setting; a future per-persona override can layer on top (see brands TODO
-- below) without changing this shape.
--
-- Idempotent; safe to re-run. RLS enabled with no anon policies, consistent
-- with every other table in this schema — the app (service-role client) scopes
-- all reads/writes by account_id; RLS just guarantees the anon/browser key can
-- never see or touch these rows directly.

CREATE TABLE IF NOT EXISTS ai_providers (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,                 -- operator-facing label, e.g. "Team OpenAI"
  kind               TEXT NOT NULL,                  -- openai-compatible | anthropic | zoask | opencode | nim | gemini | custom
  base_url           TEXT,                           -- override endpoint; NULL uses the kind's default
  api_key_encrypted  TEXT,                           -- AES-256-GCM ciphertext (lib/ai/crypto.ts); NULL for zoask/opencode/nim/gemini when they ride the platform's own env key
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_providers_kind_check CHECK (kind IN ('openai-compatible','anthropic','zoask','opencode','nim','gemini','custom'))
);
CREATE INDEX IF NOT EXISTS idx_ai_providers_account ON ai_providers(account_id);

CREATE TABLE IF NOT EXISTS ai_models (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id UUID NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,                         -- upstream model identifier, e.g. "gpt-4.1" / "claude-sonnet-4-5"
  label       TEXT,                                  -- operator-facing display name; defaults to model_id in the UI
  tier        TEXT NOT NULL DEFAULT 'balanced',       -- fast | balanced | heavy
  good        TEXT[] NOT NULL DEFAULT '{}',           -- task tags this model is routed for, e.g. {classify,draft}
  reliable    BOOLEAN NOT NULL DEFAULT TRUE,          -- false = catalogued but not auto-routed (mirrors lib/ai/models.ts GoModel.reliable)
  enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT ai_models_tier_check CHECK (tier IN ('fast','balanced','heavy'))
);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);

-- One routing row per account: the active model + an ordered fallback chain of
-- ai_models.id values (jsonb array, not a FK array, so the chain can be
-- reordered/pruned without a join table). Application code validates each id
-- still resolves to an enabled model belonging to this account at call time.
CREATE TABLE IF NOT EXISTS ai_routing (
  account_id       UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  active_model_id  UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  fallback_chain   JSONB NOT NULL DEFAULT '[]'::jsonb,  -- ordered [ai_models.id, ...], tried after active_model_id
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional per-persona/venture model override. Trivial add (mirrors 019's
-- ALTER-COLUMN style); NULL means "use the account's ai_routing default".
ALTER TABLE brands ADD COLUMN IF NOT EXISTS preferred_model_id UUID REFERENCES ai_models(id) ON DELETE SET NULL;

-- Per-call usage ledger — every generateText/generateChat call through the
-- registry path records who answered + what it cost, extending (not
-- replacing) the credits.ts ledger in credit_transactions. Kept separate from
-- credit_transactions because this is a technical/observability log (raw
-- tokens + latency + which tier), not a billing-balance mutation; a caller
-- that also wants to spend credits still calls applyCredits() itself, keyed
-- off ref_id = ai_usage.id, so nothing double-bills.
CREATE TABLE IF NOT EXISTS ai_usage (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider_id   UUID REFERENCES ai_providers(id) ON DELETE SET NULL,
  model_id      UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  model_label   TEXT,                                 -- denormalized snapshot; survives provider/model deletion
  kind          TEXT NOT NULL DEFAULT 'text',          -- text | chat
  tokens_in     INT,
  tokens_out    INT,
  latency_ms    INT,
  ok            BOOLEAN NOT NULL DEFAULT TRUE,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_account ON ai_usage(account_id, created_at DESC);

-- RLS parity with the rest of the schema (service-role bypasses; app scopes by
-- account_id in every query — see lib/ai/providers.ts).
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_providers','ai_models','ai_routing','ai_usage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY;', t);
  END LOOP;
END $$;

-- ============================================================================
-- 024_personas.sql — Multi-persona agent roster, per account.
-- NOTE: model_id FK requires ai_models (023_ai_providers.sql) to be applied
-- first; append 023 to this file before 024 if regenerating from scratch.
-- ============================================================================
CREATE TABLE IF NOT EXISTS personas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  role           TEXT,
  instructions   TEXT NOT NULL DEFAULT '',
  model_id       UUID REFERENCES ai_models(id) ON DELETE SET NULL,
  tone           TEXT,
  avatar         TEXT,
  is_coordinator BOOLEAN NOT NULL DEFAULT FALSE,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order     INT NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_personas_account ON personas(account_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_one_coordinator
  ON personas(account_id)
  WHERE is_coordinator = TRUE AND enabled = TRUE;

ALTER TABLE personas ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 025_skills.sql — Skills catalog (system + account-authored) + per-account
-- enable state. Additive: the 12 built-ins in lib/skills/registry.ts are
-- untouched; zero enabled account_skills rows = zero behavior change.
-- ============================================================================
CREATE TABLE IF NOT EXISTS skills (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID REFERENCES accounts(id) ON DELETE CASCADE,
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  instructions   TEXT NOT NULL DEFAULT '',
  source         TEXT,
  license        TEXT,
  inspired_by    TEXT,
  quality_flags  JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_global_slug
  ON skills(slug) WHERE account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_skills_account_slug
  ON skills(account_id, slug) WHERE account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_skills_account ON skills(account_id);
CREATE INDEX IF NOT EXISTS idx_skills_category ON skills(category);

ALTER TABLE skills ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS account_skills (
  account_id              UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  skill_id                UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  enabled                 BOOLEAN NOT NULL DEFAULT TRUE,
  overridden_instructions TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_account_skills_account ON account_skills(account_id);

ALTER TABLE account_skills ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 026_mcp_clients.sql — External MCP server registry, per account. Inverse of
-- the existing MCP server (app/api/mcp/route.ts). Registry only in this
-- migration; wiring discovered tools into the agent loop is a later task.
-- ============================================================================
CREATE TABLE IF NOT EXISTS mcp_clients (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  transport          TEXT NOT NULL,
  url                TEXT NOT NULL,
  auth_header_encrypted TEXT,
  enabled            BOOLEAN NOT NULL DEFAULT TRUE,
  last_status        TEXT,
  last_checked_at    TIMESTAMPTZ,
  discovered_tools   JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mcp_clients_transport_check CHECK (transport IN ('http','sse')),
  CONSTRAINT mcp_clients_account_name_unique UNIQUE (account_id, name)
);
CREATE INDEX IF NOT EXISTS idx_mcp_clients_account ON mcp_clients(account_id);

ALTER TABLE mcp_clients ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 027_scheduled_tasks.sql — Account-scoped recurring agent tasks. Named
-- intervals only (hourly/daily/weekly) — no cron parsing.
-- ============================================================================
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  interval       TEXT NOT NULL,
  enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at    TIMESTAMPTZ,
  next_run_at    TIMESTAMPTZ,
  last_status    TEXT,
  last_result    TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT scheduled_tasks_interval_check CHECK (interval IN ('hourly','daily','weekly'))
);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_account ON scheduled_tasks(account_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_due ON scheduled_tasks(next_run_at) WHERE enabled = TRUE;

ALTER TABLE scheduled_tasks ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 028_approvals.sql — Durable approvals workflow for the agent's approval
-- gate. Additive alongside the existing in-memory needs_approval/resume flow
-- (lib/agent/loop.ts) — a persisted audit trail with actor, comment,
-- no-self-approval, and edit-invalidation, not a replacement execution path.
-- ============================================================================
CREATE TABLE IF NOT EXISTS approvals (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID,
  tool            TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  args_encrypted  TEXT,
  args_redacted   JSONB NOT NULL DEFAULT '{}'::jsonb,
  args_hash       TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  requested_by    TEXT,
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  comment         TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT approvals_state_check CHECK (state IN ('pending','approved','rejected','expired','invalidated'))
);
CREATE INDEX IF NOT EXISTS idx_approvals_account_state ON approvals(account_id, state);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 029_journeys.sql — Visual journey / automation graph (C1).
-- ============================================================================
-- 029_journeys.sql — Visual journey / automation graph, per account.
--
-- The evolution of lib/sequences.ts (linear) into a branching DAG: a journey
-- is a named graph of nodes (trigger | send_email | wait | condition | goal |
-- exit) connected by edges. Nodes + edges live in the `graph` JSONB
-- (shape: { nodes: [{ id, type, config, next: [{ to, when? }] }] }).
-- `trigger` and `status` are denormalized for listing/activation.
--
-- Scoping/RLS convention matches 025/027/028/032: account_id UUID NOT NULL,
-- RLS enabled with no anon policies — service-role bypasses; the app scopes
-- every read/write by account_id in code (see lib/journeys/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS journeys (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'draft',              -- draft | active | paused | archived
  trigger      TEXT NOT NULL DEFAULT 'manual',             -- manual | lead_created | tag_added | stage_changed
  graph        JSONB NOT NULL DEFAULT '{"nodes":[]}'::jsonb,
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT journeys_status_check CHECK (status IN ('draft','active','paused','archived'))
);

CREATE INDEX IF NOT EXISTS idx_journeys_account ON journeys(account_id);
CREATE INDEX IF NOT EXISTS idx_journeys_account_status ON journeys(account_id, status);

ALTER TABLE journeys ENABLE ROW LEVEL SECURITY;

-- ============================================================================
-- 032_content_pipeline.sql — Scout→Planner→Creator→Reviewer→Publisher→Analyst (A1b).
-- ============================================================================
-- 032_content_pipeline.sql — Account-scoped content-creation pipeline runs.
--
-- Implements the "Scout -> Planner -> Creator -> Reviewer -> Publisher ->
-- Analyst" content pipeline (socialflow-style). Each row is ONE run of the
-- pipeline for a given topic. The six stages are stored as an ordered JSONB
-- array in `stages` (each entry: key, status, output, error, timestamps);
-- `status`/`current_stage` are denormalized for fast listing, and `output`
-- holds the final assembled result (analyst summary) or a failure record.
-- The orchestrator that walks the stages lives in lib/pipeline/store.ts.
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql: account_id UUID NOT NULL, RLS enabled with no anon
-- policies — service-role bypasses, the app scopes every read/write by
-- account_id in code (see lib/pipeline/store.ts, app/api/pipeline/*).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS content_pipeline_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  topic         TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',          -- running | completed | failed
  current_stage TEXT,                                     -- scout | planner | creator | reviewer | publisher | analyst
  stages        JSONB NOT NULL DEFAULT '[]'::jsonb,       -- ordered array of stage results
  output        JSONB,                                    -- final assembled result, or failure record
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_pipeline_runs_status_check CHECK (status IN ('running','completed','failed'))
);

CREATE INDEX IF NOT EXISTS idx_content_pipeline_runs_account ON content_pipeline_runs(account_id);
CREATE INDEX IF NOT EXISTS idx_content_pipeline_runs_created ON content_pipeline_runs(created_at DESC);

ALTER TABLE content_pipeline_runs ENABLE ROW LEVEL SECURITY;

-- 030_segments.sql
-- 030_segments.sql — Dynamic contact segments, per account.
--
-- A segment is a saved, re-runnable filter over `contacts`: a name/description
-- plus a `filters` JSONB array of {field, op, value} triples. The whitelist of
-- allowed fields/ops lives in code (lib/segments/store.ts translateFilters) —
-- this table just stores the definition; it never stores raw SQL.
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql / 029_journeys.sql: account_id UUID NOT NULL, RLS enabled
-- with no anon policies — service-role bypasses, the app scopes every
-- read/write by account_id in code (see lib/segments/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS segments (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  filters      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- [{field, op, value}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_segments_account ON segments(account_id);

ALTER TABLE segments ENABLE ROW LEVEL SECURITY;

-- 031_events.sql
-- 031_events.sql — Lightweight event log, per account (Postgres-only CDP).
--
-- Every row is one tracked event (e.g. email_opened, page_viewed) optionally
-- tied to a contact, with a free-form JSONB `props` bag. No ClickHouse/Kafka —
-- this is deliberately simple; lib/analytics/store.ts aggregates with plain
-- SQL over this table (counts, timeseries).
--
-- Scoping/RLS convention matches 025_skills.sql / 027_scheduled_tasks.sql /
-- 028_approvals.sql / 029_journeys.sql / 030_segments.sql: account_id UUID
-- NOT NULL, RLS enabled with no anon policies — service-role bypasses, the
-- app scopes every read/write by account_id in code (see lib/analytics/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id   UUID,
  type         TEXT NOT NULL,
  props        JSONB DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_account_created ON events(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_account_type ON events(account_id, type);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;

-- 033_budgets.sql
-- 033_budgets.sql — Per-account spend budgets / credit caps.
--
-- One row per account: an optional monthly credit limit, an alert threshold
-- (%), and an optional hard-stop switch. `enabled=false` by default so this
-- is entirely opt-in — with no row (or enabled=false), spend is unaffected.
-- lib/budgets/store.ts computes `spent` on the fly from credit_transactions
-- (no running counter to keep in sync).
--
-- Scoping/RLS convention matches 030_segments.sql / 031_events.sql:
-- account_id UUID NOT NULL, RLS enabled with no anon policies — service-role
-- bypasses, the app scopes every read/write by account_id in code.
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS account_budgets (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id            UUID NOT NULL UNIQUE REFERENCES accounts(id) ON DELETE CASCADE,
  monthly_limit_credits INTEGER,
  alert_threshold_pct   INTEGER NOT NULL DEFAULT 80,
  hard_stop             BOOLEAN NOT NULL DEFAULT FALSE,
  enabled               BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_account_budgets_account ON account_budgets(account_id);

ALTER TABLE account_budgets ENABLE ROW LEVEL SECURITY;

-- 034_notifications.sql
-- 034_notifications.sql — In-app notifications, per account.
--
-- Simple flat feed: type/title/body/link + read flag. No push/email fan-out
-- here — this table is just the in-app bell/panel backing store.
--
-- Scoping/RLS convention matches 030_segments.sql / 031_events.sql /
-- 033_budgets.sql: account_id UUID NOT NULL, RLS enabled with no anon
-- policies — service-role bypasses, the app scopes every read/write by
-- account_id in code (see lib/notifications/store.ts).
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS notifications (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type         TEXT,
  title        TEXT NOT NULL,
  body         TEXT,
  link         TEXT,
  read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_account_created ON notifications(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_account_read ON notifications(account_id, read);

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- 035_forms.sql
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

-- ===== 036_agent_memory_embeddings.sql =====
-- 036_agent_memory_embeddings.sql — Semantic recall for durable memory (B4).
--
-- Adds a pgvector embedding to agent_memory so the copilot can recall facts by
-- MEANING (nv-embedqa-e5-v5, 1024-dim), not just recency/keyword. Blended with
-- the existing recency digest in lib/agent/memory.ts; recall degrades to recency
-- when embeddings are absent, so this is a pure additive upgrade.
--
-- Tenancy: match_agent_memory() takes p_account_id and filters on it — the app
-- always passes the session accountId, never a client value. agent_memory has no
-- RLS (service-role + in-code account scoping), matching migration 022.
-- Idempotent; safe to re-run.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS embedding vector(1024);

-- Approximate nearest-neighbor over cosine distance. HNSW needs no training step
-- (unlike ivfflat) and stays correct as rows are added incrementally.
CREATE INDEX IF NOT EXISTS idx_agent_memory_embedding
  ON agent_memory USING hnsw (embedding vector_cosine_ops);

-- Account-scoped semantic search. Returns the closest facts to p_query for one
-- account, nearest first, with a cosine similarity score in [0,1]. Rows without
-- an embedding are excluded (they still surface via the recency digest).
CREATE OR REPLACE FUNCTION match_agent_memory(
  p_account_id UUID,
  p_query      vector(1024),
  p_limit      INT DEFAULT 8
)
RETURNS TABLE (id UUID, fact TEXT, similarity REAL) AS $$
  SELECT m.id, m.fact, (1 - (m.embedding <=> p_query))::real AS similarity
  FROM agent_memory m
  WHERE m.account_id = p_account_id
    AND m.embedding IS NOT NULL
  ORDER BY m.embedding <=> p_query
  LIMIT GREATEST(p_limit, 1);
$$ LANGUAGE sql STABLE;

-- ===========================================================================
-- 037_approval_execution.sql
-- Adds the terminal 'executed' state to the approval lifecycle (Packet 0.1),
-- so an approved action is consumed exactly once and the audit trail records
-- that it actually ran. args_hash index backs the no-drift check.
-- ===========================================================================

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_state_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_state_check
  CHECK (state IN ('pending','approved','rejected','expired','invalidated','executed'));
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_approvals_account_tool_hash ON approvals(account_id, tool, args_hash);

-- ===========================================================================
-- 038_model_output_limits.sql
-- Per-model output ceiling, so an answer's length follows the capability of
-- whichever model actually serves it rather than one hardcoded constant.
-- NULL means unknown; callers fall back to a conservative default.
-- ===========================================================================

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

-- ===========================================================================
-- 039_mcp_keys.sql
-- Per-account API keys for LeadRail's OWN MCP server (Packet 0.3). Replaces
-- the single shared APP_API_SECRET as the authorisation decision: a bearer
-- maps to exactly one account, and sensitive tools need an explicit per-key
-- opt-in. The token itself is NEVER stored, only its sha256. Revocation is a
-- timestamp, not a delete, so the audit trail survives.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS mcp_api_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,
  key_hash        TEXT NOT NULL UNIQUE,
  allow_sensitive BOOLEAN NOT NULL DEFAULT FALSE,
  last_used_at    TIMESTAMPTZ,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_key_hash ON mcp_api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_mcp_api_keys_account ON mcp_api_keys(account_id);
ALTER TABLE mcp_api_keys ENABLE ROW LEVEL SECURITY;

-- ===========================================================================
-- 040_social_automations.sql
-- Standing rules over social activity (Packet 2.2-S). A row is a RULE, not an
-- action. Two safety properties are enforced here rather than in code:
--   1. `enabled` defaults FALSE — creating a rule and switching it on are two
--      separate approvals, so one approval can never yield a live auto-sender.
--   2. `daily_cap` is bounded by a DB CHECK, so no code path (capability, MCP
--      caller, or the Packet 7.3 runner) can store a rule allowed to send more
--      than 200 times a day.
-- The execution runner is Packet 7.3; until it exists these rows never fire.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS social_automations (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform      TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  trigger       TEXT NOT NULL,
  match         JSONB NOT NULL DEFAULT '{}'::jsonb,
  action        TEXT NOT NULL,
  template      TEXT,
  daily_cap     INT NOT NULL DEFAULT 25,
  sends_today   INT NOT NULL DEFAULT 0,
  last_reset_at DATE,
  enabled       BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT social_automations_cap_check CHECK (daily_cap > 0 AND daily_cap <= 200),
  CONSTRAINT social_automations_trigger_check CHECK (trigger IN ('comment_received','dm_received','mention')),
  CONSTRAINT social_automations_action_check CHECK (action IN ('reply','hide','notify','tag_lead'))
);
CREATE INDEX IF NOT EXISTS idx_social_automations_account ON social_automations(account_id, enabled);
ALTER TABLE social_automations ENABLE ROW LEVEL SECURITY;

-- ============ 050_content_engine.sql ============
-- 050_content_engine.sql — the content engine shell.
--
-- LeadRail already had content_pipeline_runs (migration 032): one topic walked
-- through six stages, then finished. That is a RUN. It is not a content
-- operation. A run has no lifecycle, no board to look at, no notion of which
-- pillar a piece serves, no per-platform constraints, and nothing survives it
-- but a blob of text.
--
-- This adds the three tables the engine was missing, all account-scoped and all
-- brand-OPTIONAL: the shell has to work before a venture exists, and a piece of
-- content that belongs to no particular brand is a legitimate thing to plan.
--
--   content_pillars   the 3-5 recurring themes a brand rotates through
--   platform_specs    per-platform constraints every generator should obey
--   content_items     the actual pieces, with a lifecycle
--
-- Scoping/RLS convention matches 032/047/048: account_id UUID NOT NULL, RLS on
-- with no anon policies — service-role bypasses, the app scopes every read and
-- write by account_id in code. Idempotent; safe to re-run.

-- ---------------------------------------------------------------------------
-- Pillars. A pillar is a promise the brand keeps making: a pain it names and
-- the relief it offers. Content rotates through them so a feed does not become
-- five variations of one idea. Brand-optional: an account can define house
-- pillars that every venture inherits.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_pillars (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id    TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  -- The pain this pillar speaks to, and what the brand says instead. Kept as
  -- two plain columns rather than one blob because the generator uses them
  -- differently: `pain` seeds the hook, `promise` seeds the payoff.
  pain        TEXT,
  promise     TEXT,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_content_pillars_scope
  ON content_pillars(account_id, brand_id, sort_order);

-- ---------------------------------------------------------------------------
-- Platform specs. Every generator in this codebase took the platform as a bare
-- string and guessed the rest — character limit, image ratio, hashtag
-- convention, CTA shape, when to post. Those are facts, not judgement calls,
-- and writing them down once is the difference between a post that fits the
-- surface and one that gets truncated.
--
-- account_id is NULLABLE here, unlike everywhere else in the schema, and that
-- is deliberate: a NULL row is a platform DEFAULT shared by every account (see
-- the seed at the bottom), and an account row overrides it. Reads take the
-- account's row when present and fall back to the default, so a new workspace
-- has correct specs on day one without seeding anything.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS platform_specs (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        UUID REFERENCES accounts(id) ON DELETE CASCADE,
  platform          TEXT NOT NULL,
  char_limit        INT,
  image_specs       TEXT,
  hashtag_strategy  TEXT,
  cta_format        TEXT,
  copy_tone         TEXT,
  optimal_time      TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One row per platform per account, and one global default per platform.
-- Two partial indexes because NULL never equals NULL in a unique constraint,
-- so a single index over (account_id, platform) would allow unlimited
-- duplicate defaults.
CREATE UNIQUE INDEX IF NOT EXISTS platform_specs_account_uidx
  ON platform_specs(account_id, platform) WHERE account_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS platform_specs_default_uidx
  ON platform_specs(platform) WHERE account_id IS NULL;

-- ---------------------------------------------------------------------------
-- Content items. The board: one row per piece of content, moving through a
-- lifecycle. This is what content_pipeline_runs never was — a run produces an
-- item, and the item outlives the run.
--
-- hook / body / cta are separate columns rather than one `content` blob because
-- the unit structure is the point: the hook stops the scroll, the body carries
-- the substance, the CTA asks. They are reviewed, tested and swapped
-- independently, and a generator that returns one blob cannot be A/B tested on
-- its hook alone.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS content_items (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id        TEXT REFERENCES brands(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'IDEATION',
  content_type    TEXT,
  platforms       TEXT[] NOT NULL DEFAULT '{}',
  pillar_id       UUID REFERENCES content_pillars(id) ON DELETE SET NULL,
  pillar          TEXT,
  funnel_stage    TEXT,
  key_angle       TEXT,
  target_audience TEXT,
  hook            TEXT,
  body            TEXT,
  cta             TEXT,
  hashtags        TEXT[] NOT NULL DEFAULT '{}',
  image_prompt    TEXT,
  media_url       TEXT,
  -- Where it came from, when the engine made it. Null for a hand-written item —
  -- the board must accept both.
  pipeline_run_id UUID REFERENCES content_pipeline_runs(id) ON DELETE SET NULL,
  -- Set once the item has actually gone out, so the board can distinguish
  -- "approved and waiting" from "live".
  scheduled_for   TIMESTAMPTZ,
  published_at    TIMESTAMPTZ,
  external_post_id TEXT,
  performance     JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT content_items_status_check CHECK (
    status IN ('IDEATION','OUTLINE','DRAFT','APPROVED','QUEUED','PUBLISHED','ARCHIVED')
  ),
  CONSTRAINT content_items_funnel_check CHECK (
    funnel_stage IS NULL OR funnel_stage IN ('Awareness','Consideration','Decision')
  )
);
CREATE INDEX IF NOT EXISTS idx_content_items_board
  ON content_items(account_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_brand
  ON content_items(account_id, brand_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_due
  ON content_items(account_id, scheduled_for) WHERE scheduled_for IS NOT NULL;

ALTER TABLE content_pillars ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_specs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items   ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.content_pillars FROM anon, authenticated;
REVOKE ALL ON public.platform_specs  FROM anon, authenticated;
REVOKE ALL ON public.content_items   FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Default platform specs (account_id NULL). Deliberately conservative: these
-- are the constraints a generator must not exceed, not aspirations. An account
-- overrides any of them with its own row.
-- ---------------------------------------------------------------------------
INSERT INTO platform_specs (account_id, platform, char_limit, image_specs, hashtag_strategy, cta_format, copy_tone, optimal_time)
VALUES
  (NULL, 'instagram', 2200, '1080x1350 portrait (4:5) for feed, 1080x1920 (9:16) for reels and stories',
   '3-5 specific niche tags, not broad ones; in the caption, not the first comment',
   'Comment-bait question, or "link in bio" — Instagram captions cannot carry live links',
   'Warm, first-person, native. Front-load the hook — captions truncate at ~125 characters.',
   'Weekdays 11:00-13:00 and 19:00-21:00 local'),
  (NULL, 'facebook', 63206, '1200x630 landscape for links, 1080x1350 for native photo posts',
   '0-2 tags; Facebook rewards none',
   'Live link in the post body works here',
   'Conversational, slightly longer than Instagram. Questions perform.',
   'Weekdays 09:00-12:00 local'),
  (NULL, 'linkedin', 3000, '1200x627 landscape, or 1080x1350 portrait for higher feed share',
   '3-5 professional tags at the end',
   'Ask for a comment or reply; links in the post body suppress reach, prefer first comment',
   'Direct, specific, no hype. Concrete numbers and named situations beat adjectives.',
   'Tuesday-Thursday 08:00-10:00 local'),
  (NULL, 'x', 280, '1600x900 landscape',
   '0-2 tags; more reads as spam',
   'Reply-bait or a link on its own line',
   'Compressed. One idea per post. No preamble.',
   'Weekdays 09:00-11:00 and 17:00-19:00 local'),
  (NULL, 'tiktok', 2200, '1080x1920 vertical (9:16), 10-60s',
   '3-5 tags mixing one broad and several niche',
   'Spoken CTA in the last 2 seconds plus an on-screen overlay',
   'Spoken-word cadence. The first 3 seconds decide everything.',
   'Daily 18:00-22:00 local'),
  (NULL, 'threads', 500, '1080x1350 portrait',
   'Threads does not surface hashtags; skip them',
   'Ask a question — the surface is conversational',
   'Casual, unpolished, reply-oriented.',
   'Daily 12:00-14:00 and 20:00-22:00 local')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Brand kit fields the platform was missing.
--
-- brands already carries name, description, pitch, sectors and lead goal —
-- enough to source leads, not enough to write in a brand's voice. These four
-- are what a generator actually needs and had no way to read: how the brand
-- sounds, where it plays, and what "good" looks like for it.
--
-- content_examples is the highest-leverage of the four. A model given three
-- real posts that worked writes far closer to the mark than one given an
-- adjective like "bold".
-- ---------------------------------------------------------------------------
ALTER TABLE brands ADD COLUMN IF NOT EXISTS tone_of_voice     TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS platform_strategy TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS content_examples  TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS key_messaging     TEXT;

-- ---------------------------------------------------------------------------
-- Character references — the avatar consistency system.
--
-- Text-to-image regenerates the character from scratch every call, so the
-- "same" avatar drifts: different face, different wardrobe, different style,
-- post to post. The fix is not a better prompt. It is to generate a reference
-- ONCE and condition every later generation on that image, changing only the
-- scene variables.
--
-- A row here is that anchor: the reference image, the fixed description that
-- travels with it, and a style-lock suffix appended to every prompt using it.
-- Brand-optional, like everything else in this migration.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_refs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id      TEXT REFERENCES brands(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- The anchor image. Every conditioned generation references this URL, so it
  -- must stay reachable — it is a stored asset, not a transient result.
  image_url     TEXT NOT NULL,
  -- The invariant half of every prompt: who this character is, what they wear,
  -- what they are holding. Never varies between generations.
  description   TEXT NOT NULL,
  -- Appended verbatim to every prompt conditioned on this reference, e.g.
  -- "consistent stylized character identity, brand colors #1A3A52 and #FFB627,
  -- clean modern illustrative style, matches reference image".
  style_lock    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_character_refs_scope
  ON character_refs(account_id, brand_id, created_at DESC);

ALTER TABLE character_refs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.character_refs FROM anon, authenticated;

-- ============ 051_skill_capabilities.sql ============
-- 051_skill_capabilities.sql — skills that reach the tools, plus a screen record.
--
-- WHAT A SKILL COULD DO BEFORE THIS. `instructions` is spliced into the system
-- prompt and that is all. A skill could change how the assistant WRITES; it
-- could not change what the assistant DOES. So a skill called "competitor
-- teardown" that plainly needs a web search had no way to say so — it could
-- only describe a teardown and hope the model chose webSearch on its own.
--
-- The upstream console this pattern comes from solves it by registering a
-- skill DIRECTORY into the toolkit, scripts and all, so the agent can execute
-- the skill. That does not port: this is a multi-tenant web app, and arbitrary
-- per-account scripts executing server-side is a tenancy boundary with a hole
-- in it, not a feature.
--
-- The honest adaptation is to let a skill declare the CAPABILITIES it is about.
-- Those names are real entries in the capability registry, validated against
-- it, and every one already carries its own approval gate and account scoping.
-- A skill gains reach without gaining privilege: it can say "this work needs
-- webSearch and createFile", and the assistant is told so at the point the
-- guidance applies — but the tools it names are the same tools, gated the same
-- way, that the assistant could already call.
--
-- Idempotent; safe to re-run.

-- Capability names this skill's guidance is about. Validated against the
-- registry at read time, NOT by a FK: capabilities live in TypeScript
-- (lib/capabilities/registry.ts), not in a table, and a stale name must
-- degrade to "ignored" rather than blocking the skill from loading at all.
ALTER TABLE skills ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';

-- ---------------------------------------------------------------------------
-- Screen results.
--
-- lib/skills/security.ts screens every skill's text before it reaches the
-- system prompt, and until now that verdict lived only in a log line. Storing
-- it means the catalog can be audited without re-running the screen over 353
-- skills, an owner can see WHICH skills were refused and why, and a repaired
-- skill can be re-screened and cleared.
--
-- Deliberately on `skills` rather than a separate table: a verdict is a
-- property of that skill's current text, and it must be invalidated by the
-- same UPDATE that changes the text. A side table would drift.
-- ---------------------------------------------------------------------------
ALTER TABLE skills ADD COLUMN IF NOT EXISTS screen_status  TEXT NOT NULL DEFAULT 'unscreened';
ALTER TABLE skills ADD COLUMN IF NOT EXISTS screen_findings JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE skills ADD COLUMN IF NOT EXISTS screened_at    TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'skills_screen_status_check' AND conrelid = 'skills'::regclass
  ) THEN
    ALTER TABLE skills
      ADD CONSTRAINT skills_screen_status_check
      CHECK (screen_status IN ('unscreened','clean','flagged','blocked','repaired'));
  END IF;
END $$;

-- Owners look at this in one order: what is blocked, then what is flagged.
CREATE INDEX IF NOT EXISTS idx_skills_screen_status
  ON skills(screen_status) WHERE screen_status IN ('blocked', 'flagged');

-- ---------------------------------------------------------------------------
-- Repair proposals.
--
-- When the screen blocks a skill, the fix is usually small and mechanical — a
-- stray instruction that reads as an override, a fenced shell block in what
-- should be prose. An LLM can propose that fix.
--
-- It MUST NOT apply it. A healer that repairs a blocked skill and reinstates
-- it automatically is a laundering path: get text past the model's idea of
-- "fixed" and it lands back in the system prompt with the screen's own
-- blessing. So a repair is a PROPOSAL, stored here, reviewed by an owner, and
-- only their approval writes it back to skills.instructions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS skill_repairs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id      UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  account_id    UUID REFERENCES accounts(id) ON DELETE CASCADE,
  -- The text as it stood when the repair was proposed. Kept so a reviewer can
  -- diff, and so a proposal against text that has since changed can be spotted
  -- and discarded rather than silently overwriting newer content.
  original      TEXT NOT NULL,
  proposed      TEXT NOT NULL,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT skill_repairs_status_check CHECK (status IN ('pending','applied','rejected','stale'))
);
CREATE INDEX IF NOT EXISTS idx_skill_repairs_pending
  ON skill_repairs(status, created_at DESC) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_skill_repairs_skill ON skill_repairs(skill_id, created_at DESC);

ALTER TABLE skill_repairs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.skill_repairs FROM anon, authenticated;

-- ============ 052_schema_guard.sql ============
-- 052_schema_guard.sql — introspection for the schema-drift check.
--
-- WHY: four migrations (039, 042, 043, 044) sat unapplied against production
-- for weeks and nothing noticed, because nothing compares the schema the
-- deployed code writes against with the schema that is actually there. The
-- symptom, when it finally surfaced, was a modal saying "Internal error" over
-- a log line reading PGRST204, column 'allow_auto' not found.
--
-- PostgREST does not expose information_schema, so the application cannot ask
-- "does this column exist?" directly. This is the narrowest possible window
-- onto that question: given a list of table names, return the (table, column)
-- pairs that exist in the public schema. Nothing else.
--
-- SECURITY DEFINER with a pinned search_path, and it returns only NAMES —
-- never a value, never a row of anyone's data. The worst an unexpected caller
-- learns is the shape of a schema they can already infer from the API's own
-- error messages.
--
-- Idempotent; safe to re-run.

CREATE OR REPLACE FUNCTION public.schema_columns_for(p_tables TEXT[])
RETURNS TABLE (table_name TEXT, column_name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
STABLE
AS $$
  SELECT c.table_name::text, c.column_name::text
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.table_name = ANY(p_tables);
$$;

-- Service-role only. The app calls this with the service key; no anon or
-- authenticated client has any reason to introspect the schema.
REVOKE ALL ON FUNCTION public.schema_columns_for(TEXT[]) FROM PUBLIC, anon, authenticated;

-- ============ 053_mcp_oauth.sql ============
-- 053_mcp_oauth.sql — OAuth for external MCP servers.
--
-- WHY: lib/mcp/client.ts sends a static `Authorization` header and nothing
-- else. That is enough for a server issuing a long-lived token, and useless
-- for the growing number that are OAuth-protected — Higgsfield among them.
-- There was no discovery, no client registration, no PKCE, no refresh, so
-- those servers were simply unreachable and the UI had no way to say why.
--
-- Two additions, and one deliberate omission.
--
-- ADDED: per-connection OAuth state on mcp_clients (which authorization server,
-- which client_id we registered as, the encrypted tokens, when they expire),
-- and a short-lived table for in-flight authorization attempts.
--
-- OMITTED: any storage of the PKCE verifier outside the server. The verifier is
-- the secret that proves the token request came from whoever started the flow;
-- putting it in a cookie or a signed blob handed to the browser means an
-- attacker who can read it can complete someone else's authorization. It lives
-- in mcp_oauth_states, is looked up by an opaque `state` value, and is deleted
-- the moment it is used.
--
-- Idempotent; safe to re-run.

-- How this connection authenticates. 'header' is every existing row — a static
-- Authorization header — and stays the default so nothing already registered
-- changes behaviour.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS auth_mode TEXT NOT NULL DEFAULT 'header';

-- Discovery + registration results, so a reconnect does not re-register and a
-- refresh knows where to go. None of this is secret: an authorization endpoint
-- is public, and a dynamically-registered client_id identifies us, it does not
-- authenticate us.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_issuer          TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_authorize_url   TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_token_url       TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_registration_url TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_client_id       TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_scope           TEXT;

-- Secrets. Encrypted with the same lib/ai/crypto vault that protects
-- auth_header_encrypted — never plaintext, never returned by the API
-- projection (see toSafe in lib/mcp/clients.ts).
--
-- A dynamically-registered client MAY be issued a client_secret; most public
-- clients are not, which is why PKCE is mandatory below rather than optional.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_client_secret_encrypted  TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_access_token_encrypted   TEXT;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_refresh_token_encrypted  TEXT;

-- Expiry drives proactive refresh. Nullable because a server may issue a token
-- with no stated lifetime, in which case we refresh reactively on a 401 rather
-- than guessing a duration.
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_expires_at TIMESTAMPTZ;
ALTER TABLE mcp_clients ADD COLUMN IF NOT EXISTS oauth_connected_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'mcp_clients_auth_mode_check' AND conrelid = 'mcp_clients'::regclass
  ) THEN
    ALTER TABLE mcp_clients
      ADD CONSTRAINT mcp_clients_auth_mode_check CHECK (auth_mode IN ('header', 'oauth'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- In-flight authorization attempts.
--
-- One row per "user clicked Connect", deleted on completion. Holds the PKCE
-- verifier — the one genuinely secret part of the exchange — plus the account
-- and connection the callback belongs to, so the callback route needs no
-- session cookie and trusts nothing the browser hands it except an opaque
-- lookup key.
--
-- `state` is the lookup key AND the CSRF defence: it is random, single-use, and
-- a callback whose state is not in this table is refused outright.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mcp_oauth_states (
  state          TEXT PRIMARY KEY,
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  client_id      UUID NOT NULL REFERENCES mcp_clients(id) ON DELETE CASCADE,
  -- PKCE. Stored server-side only; see the header note.
  code_verifier  TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Ten minutes is the standard authorization-code window. An expired row is
  -- refused even if it is still present, so a stalled tab cannot be completed
  -- an hour later.
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '10 minutes')
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_states_expiry ON mcp_oauth_states(expires_at);

ALTER TABLE mcp_oauth_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.mcp_oauth_states FROM anon, authenticated;

-- ============ 054_brand_canon.sql ============
-- 054_brand_canon.sql — brand linearity as an enforceable constraint.
--
-- THE PROBLEM. A brand kit today is adjectives: tone_of_voice, key_messaging,
-- content_examples. Handed to a model alongside character limits, hashtag
-- rules, aspect ratios and SEO keywords, adjectives lose. That is attention
-- decay, and it is why high-volume generation drifts: nothing in the prompt is
-- a constraint, so everything in it is negotiable.
--
-- Linearity is NOT repetition. Forcing identical phrasing across TikTok,
-- LinkedIn and a Meta ad fails on all three — TikTok rejects corporate
-- slogans, LinkedIn rejects hype, ads need problem-solution friction. What has
-- to stay fixed is the BELIEF; what adapts is its expression.
--
-- So the canon stores the four things that must not vary, and stores a vector
-- of the thesis so drift can be MEASURED rather than eyeballed:
--
--   core_thesis       the one non-negotiable truth the brand asserts
--   brand_enemy       the belief or status quo it argues against
--   anchor_takeaway   what the audience concludes even with the logo removed
--   mandatory_lexicon words the brand owns
--   banned_terms      generic filler that dissolves identity
--
-- WHY AN EMBEDDING COLUMN. lib/agent/embeddings.ts already produces 1024-dim
-- vectors and migration 036 already installed pgvector with a cosine index, so
-- comparing generated copy against the thesis is arithmetic we can already do.
-- A rubric asking a model "is this on-brand?" grades its own homework; cosine
-- distance to a fixed anchor does not.
--
-- Idempotent; safe to re-run.

-- ---------------------------------------------------------------------------
-- Brand canon
-- ---------------------------------------------------------------------------
ALTER TABLE brands ADD COLUMN IF NOT EXISTS core_thesis       TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS brand_enemy       TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS anchor_takeaway   TEXT;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS mandatory_lexicon TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE brands ADD COLUMN IF NOT EXISTS banned_terms      TEXT[] NOT NULL DEFAULT '{}';

-- The thesis as a vector, recomputed whenever core_thesis changes. Nullable
-- because a brand may have a thesis before the embedder is reachable, and a
-- missing vector must degrade to "cannot score drift" rather than "fails".
ALTER TABLE brands ADD COLUMN IF NOT EXISTS thesis_embedding vector(1024);

-- ---------------------------------------------------------------------------
-- Intent: the organic / paid split.
--
-- These are not one pipeline with different copy. Organic optimises for
-- retention, saves and watch-time; paid optimises for CTR, CPA and CVR, burns
-- creative far faster, and is policed by ad-network policy on claims. A piece
-- built for one is wrong for the other, and until now content_items had no way
-- to say which it was.
--
-- Defaulted to 'organic' because every row that exists today is organic — the
-- paid path lives in ad_campaigns and never wrote here.
-- ---------------------------------------------------------------------------
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS intent TEXT NOT NULL DEFAULT 'organic';

-- Variant testing. A paid asset belongs to a matrix (hook × body × cta); an
-- organic one does not. variant_group ties siblings together so a test can be
-- read as one experiment rather than eighteen unrelated drafts.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS variant_group TEXT;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS variant_label TEXT;

-- Linearity verdict, written by the evaluator before a human ever sees it.
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS linearity_score  REAL;
ALTER TABLE content_items ADD COLUMN IF NOT EXISTS linearity_report JSONB;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'content_items_intent_check' AND conrelid = 'content_items'::regclass
  ) THEN
    ALTER TABLE content_items
      ADD CONSTRAINT content_items_intent_check CHECK (intent IN ('organic', 'paid'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_content_items_intent
  ON content_items(account_id, intent, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_content_items_variant
  ON content_items(account_id, variant_group) WHERE variant_group IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Platform specs: structured, not prose.
--
-- image_specs is a sentence — "1080x1350 portrait (4:5)". A generator cannot
-- check safe-zone compliance against a sentence, and an evaluator cannot score
-- hook pacing against one either. These columns carry the same facts in a form
-- code can assert on.
--
-- hook_hold_seconds and target_hold_rate are the short-form algorithmic
-- signals: TikTok, Reels and Shorts all rank on how many viewers survive the
-- opening. A spec that omits them cannot tell a generator that the first three
-- seconds are the whole job.
-- ---------------------------------------------------------------------------
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS aspect_ratios      TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS safe_zones         TEXT;
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS format_family      TEXT;
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS hook_hold_seconds  INT;
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS algorithmic_signal TEXT;
ALTER TABLE platform_specs ADD COLUMN IF NOT EXISTS ad_policy_notes    TEXT;

-- Fill the structured fields for the six platforms already seeded. Values are
-- the same facts the prose columns carry, not new claims.
UPDATE platform_specs SET
  aspect_ratios = ARRAY['4:5','9:16','1:1'],
  format_family = 'visual',
  safe_zones = 'Keep text clear of the bottom 20% (caption/UI) and top 10% on reels.',
  hook_hold_seconds = 3,
  algorithmic_signal = 'Saves and shares outrank likes. Reels rank on watch-through and re-watch.',
  ad_policy_notes = 'Meta policy: no before/after body claims, no implied personal attributes.'
WHERE platform = 'instagram' AND account_id IS NULL;

UPDATE platform_specs SET
  aspect_ratios = ARRAY['1.91:1','4:5'],
  format_family = 'visual',
  safe_zones = 'Link previews crop to 1.91:1 — keep text out of the outer 10%.',
  algorithmic_signal = 'Comments and shares outrank reactions; native photo beats linked.',
  ad_policy_notes = 'Meta policy applies. Text-heavy creative suppresses delivery.'
WHERE platform = 'facebook' AND account_id IS NULL;

UPDATE platform_specs SET
  aspect_ratios = ARRAY['1.91:1','4:5'],
  format_family = 'text',
  algorithmic_signal = 'Dwell time and comment depth. Outbound links in the body suppress reach.',
  ad_policy_notes = 'LinkedIn ads require substantiated professional claims.'
WHERE platform = 'linkedin' AND account_id IS NULL;

UPDATE platform_specs SET
  aspect_ratios = ARRAY['16:9'],
  format_family = 'text',
  algorithmic_signal = 'Replies and reposts. One idea per post; threads for depth.'
WHERE platform = 'x' AND account_id IS NULL;

UPDATE platform_specs SET
  aspect_ratios = ARRAY['9:16'],
  format_family = 'short_video',
  safe_zones = 'Right rail and bottom 25% carry UI — no text there.',
  hook_hold_seconds = 3,
  algorithmic_signal = '3-second hold rate, completion rate and re-watch. Sound is a ranking input.',
  ad_policy_notes = 'TikTok policy: no unsubstantiated results claims, no before/after.'
WHERE platform = 'tiktok' AND account_id IS NULL;

UPDATE platform_specs SET
  aspect_ratios = ARRAY['4:5','1:1'],
  format_family = 'text',
  algorithmic_signal = 'Replies. The surface is conversational, not broadcast.'
WHERE platform = 'threads' AND account_id IS NULL;

-- ---------------------------------------------------------------------------
-- Thesis similarity.
--
-- The comparison has to happen in Postgres because that is where the vector
-- lives and where the <=> operator is. Returning the similarity rather than the
-- vector keeps the embedding server-side and hands the caller one number.
--
-- Account-scoped in the WHERE clause, not by the caller: this is the only way
-- the function can be reached, so the tenancy check belongs inside it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.brand_thesis_similarity(
  p_account_id UUID,
  p_brand_id   TEXT,
  p_query      vector(1024)
)
RETURNS REAL
LANGUAGE sql
STABLE
AS $$
  SELECT (1 - (b.thesis_embedding <=> p_query))::real
  FROM brands b
  WHERE b.id = p_brand_id
    AND b.account_id = p_account_id
    AND b.thesis_embedding IS NOT NULL;
$$;

-- ============ 055_research_vault.sql ============
-- 055_research_vault.sql — the research vault and the intake that fills it.
--
-- WHAT WAS MISSING. The assistant could already search the web and read a
-- public profile, but every finding died in the transcript. Ask it to research
-- five competitors on Monday and it has to do the whole sweep again on Tuesday,
-- because nothing kept what it learned. Research that is not stored is not
-- research, it is a conversation.
--
-- So findings land here, scoped to a brand, tagged by which pass produced them,
-- and carrying their source. Two properties matter more than the schema:
--
--   PROVENANCE. Every row records where it came from. A finding without a
--   source cannot be re-checked, and content built on unverifiable research is
--   the same failure as content built on a hallucinated tool result — it reads
--   as confident and nobody can tell.
--
--   SUPERSESSION, not deletion. A competitor changes their positioning; the old
--   finding was true when it was captured. Rows are marked superseded rather
--   than overwritten, so "what did we believe in March" stays answerable and a
--   re-run never silently rewrites history.
--
-- Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS research_findings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Brand-optional, like everything else in the content engine: a sweep can be
  -- run to inform a venture that does not exist yet.
  brand_id    TEXT REFERENCES brands(id) ON DELETE CASCADE,

  -- Which of the four passes produced this. Named rather than free-text so a
  -- caller can ask for "everything we know about competitor hooks" without
  -- string-matching.
  pass        TEXT NOT NULL,

  -- The finding itself, in one or two sentences. Deliberately short: a vault
  -- of essays is a vault nobody reads, and the source URL carries the detail.
  finding     TEXT NOT NULL,

  -- Where it came from. A URL where there is one, a handle for a social read,
  -- or the name of the tool when the finding is derived rather than quoted.
  source      TEXT,
  source_kind TEXT,

  -- Free-form structure per pass — a competitor's hook, a trend's volume, an
  -- audience phrase. jsonb so a pass can evolve what it captures without a
  -- migration, and so nothing is lost when a pass returns more than expected.
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Superseded rather than deleted — see the header.
  superseded_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT research_findings_pass_check CHECK (
    pass IN ('competitor', 'trend', 'search', 'audience')
  )
);

-- The read that matters: current findings for a brand, newest first, optionally
-- narrowed to one pass.
CREATE INDEX IF NOT EXISTS idx_research_findings_current
  ON research_findings(account_id, brand_id, pass, created_at DESC)
  WHERE superseded_at IS NULL;

ALTER TABLE research_findings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.research_findings FROM anon, authenticated;

-- ---------------------------------------------------------------------------
-- Intake.
--
-- One row per "a person described what they are building". This is the front
-- door the architecture was missing — not a form, but a record of what was
-- said, so a sweep can be re-run against the original description rather than
-- against a summary of a summary.
--
-- raw_description is kept VERBATIM and never rewritten. It is the only
-- unmediated statement of intent in the whole pipeline; everything downstream
-- is derived from it, so paraphrasing it at the door would corrupt every
-- inference made later and leave no way to notice.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS brand_intakes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  brand_id        TEXT REFERENCES brands(id) ON DELETE CASCADE,
  raw_description TEXT NOT NULL,
  -- What the operator named, before any research ran. Kept separate from the
  -- findings so a wrong competitor guess is visible as a wrong INPUT rather
  -- than appearing as a research conclusion.
  stated_competitors TEXT[] NOT NULL DEFAULT '{}',
  stated_audience    TEXT,
  stated_offer       TEXT,
  status          TEXT NOT NULL DEFAULT 'captured',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT brand_intakes_status_check CHECK (
    status IN ('captured', 'researched', 'canon_proposed', 'complete')
  )
);
CREATE INDEX IF NOT EXISTS idx_brand_intakes_account
  ON brand_intakes(account_id, created_at DESC);

ALTER TABLE brand_intakes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.brand_intakes FROM anon, authenticated;

