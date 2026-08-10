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
