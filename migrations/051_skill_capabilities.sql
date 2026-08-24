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
