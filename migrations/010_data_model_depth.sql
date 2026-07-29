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
