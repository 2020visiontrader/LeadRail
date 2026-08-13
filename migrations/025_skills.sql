-- 025_skills.sql — Skills catalog + per-account enable state.
--
-- Today lib/skills/registry.ts SKILLS is a hardcoded, in-code array of 12
-- prompt-module skills, injected into outreach generation (lib/ai/generation.ts)
-- via composeSkillGuidance/selectSkillsForGoal. This migration adds a durable,
-- account-scoped catalog on top of that in-code array WITHOUT replacing it:
--
--   - `skills`: the browsable catalog. account_id NULL rows are the global/
--     system catalog (e.g. skills harvested from OSS SKILL.md files, see
--     scripts/harvest-skills.ts + lib/skills/harvested.ts); account_id NOT
--     NULL rows are custom skills a single account authored for itself and
--     nobody else can see (enforced by the RLS-equivalent account_id scoping
--     the app already applies everywhere — service-role bypasses RLS, the app
--     scopes every read/write by account_id in code, same as 023/024).
--   - `account_skills`: which catalog skills (system OR that account's own
--     custom rows) an account has turned on, plus an optional per-account
--     instructions override so an operator can tweak a system skill's wording
--     without forking the catalog row.
--
-- The original 12 built-ins in lib/skills/registry.ts are NOT migrated into
-- this table and keep working exactly as before — see lib/skills/registry.ts
-- combined accessor. This table is additive: a NEW, optional layer of
-- catalog+harvested skills that the agent loop can also draw on, gated by
-- account_skills.enabled. Zero enabled account_skills rows (the default for
-- every existing account) = zero behavior change.
--
-- Scoping/RLS convention matches 023_ai_providers.sql / 024_personas.sql:
-- account_id UUID (NOT NULL on account_skills; nullable on skills for the
-- global-catalog case). RLS enabled with no anon policies — service-role
-- bypasses, the app scopes all reads/writes by account_id in code (see
-- app/api/skills/*). Idempotent; safe to re-run.

CREATE TABLE IF NOT EXISTS skills (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID REFERENCES accounts(id) ON DELETE CASCADE, -- NULL = global/system catalog; NOT NULL = account-authored custom skill
  slug           TEXT NOT NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  category       TEXT,
  instructions   TEXT NOT NULL DEFAULT '',        -- system-prompt fragment, same shape as lib/skills/registry.ts systemModule
  source         TEXT,                             -- provenance, e.g. 'adclaw', 'custom'
  license        TEXT,                             -- e.g. 'Apache-2.0'
  inspired_by    TEXT,
  quality_flags  JSONB NOT NULL DEFAULT '[]'::jsonb, -- e.g. ["short-body"], set by the harvest heuristic scan
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- account_id NULL rows are the shared global catalog, so a plain UNIQUE on
-- (account_id, slug) already does the right thing: NULL account_id + same
-- slug collides (Postgres treats NULLs as distinct in UNIQUE by default, so a
-- partial unique index is used instead to actually enforce global-slug
-- uniqueness across the catalog, and a second one for per-account custom slugs).
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
  overridden_instructions TEXT,                     -- NULL = use skills.instructions as-is
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (account_id, skill_id)
);

CREATE INDEX IF NOT EXISTS idx_account_skills_account ON account_skills(account_id);

ALTER TABLE account_skills ENABLE ROW LEVEL SECURITY;
