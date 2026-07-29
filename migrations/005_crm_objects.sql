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
