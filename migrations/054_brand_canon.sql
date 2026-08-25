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
