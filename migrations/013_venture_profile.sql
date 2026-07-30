-- 013_venture_profile.sql
-- Venture onboarding: a venture (brand) is no longer just a name. It carries a
-- description, a lead goal + target sectors, an uploaded pitch deck, an AI
-- summary of that deck, a derived ICP profile, and a set of enabled skills.
-- These drive tailored lead curation (goal + sectors + icp seed the Apollo
-- search) and Hermes skill/model routing. All nullable; safe to re-run.
-- Applied to project kqimpzbphdogvchqmtos via Management API on 2026-07-30.

ALTER TABLE brands ADD COLUMN IF NOT EXISTS description  text;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS lead_goal    text;          -- taxonomy key, e.g. 'investors'
ALTER TABLE brands ADD COLUMN IF NOT EXISTS sectors      jsonb NOT NULL DEFAULT '[]'::jsonb;  -- string[] of sector keys
ALTER TABLE brands ADD COLUMN IF NOT EXISTS deck_url     text;          -- durable Supabase Storage URL of the deck
ALTER TABLE brands ADD COLUMN IF NOT EXISTS deck_name    text;
ALTER TABLE brands ADD COLUMN IF NOT EXISTS deck_summary text;          -- AI plain-language summary of the deck
ALTER TABLE brands ADD COLUMN IF NOT EXISTS icp_profile  jsonb;         -- { industry, titles[], seniority[], keywords, company_size, segments[] }
ALTER TABLE brands ADD COLUMN IF NOT EXISTS skills       jsonb NOT NULL DEFAULT '[]'::jsonb;  -- string[] of skill ids (or ['auto'] = Hermes decides)
