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
