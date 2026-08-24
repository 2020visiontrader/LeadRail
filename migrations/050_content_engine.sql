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
