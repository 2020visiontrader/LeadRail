-- 066_plan_skills.sql — pin a plan's skills so guidance cannot drift mid-plan.
--
-- Skill selection is per TURN: selectSkillsForTurn (lib/agent/loop.ts) routes
-- the account's enabled skills against the current message and injects 1-4.
-- That is right for a conversation and wrong for a plan, because a plan is
-- worked one step per tick and each step is a different message — so step 3
-- can be written under different guidance than step 1, and the work silently
-- changes character partway through.
--
-- Recording the skills on the plan makes the guidance a property of the JOB
-- rather than of whichever sentence happened to trigger this tick.
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS skills TEXT[] NOT NULL DEFAULT '{}';

-- The persona that works the plan, chosen once against the OBJECTIVE.
-- Same reasoning as skills: persona selection is per turn
-- (selectPersonasForRequest routes against the message), and a plan worked one
-- step per tick would otherwise be answered by a strategist on step 1 and an
-- analyst on step 4 — the voice and the judgement change mid-job without
-- anyone asking. Null = the default assistant, which is every plan today.
ALTER TABLE agent_plans ADD COLUMN IF NOT EXISTS persona_id UUID REFERENCES personas(id) ON DELETE SET NULL;

COMMENT ON COLUMN agent_plans.persona_id IS
  'Persona pinned at plan creation, chosen against the objective. Re-applied on every resumed step so the voice and judgement stay consistent across ticks.';

COMMENT ON COLUMN agent_plans.skills IS
  'Skill slugs pinned at plan creation. Re-applied on every resumed step so guidance does not drift across ticks.';
