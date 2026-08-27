-- 063_agent_plans.sql — durable plans, so agentic work can outlive one request.
--
-- THE PROBLEM
--
-- MAX_STEPS is 16 inside a single runAgent call. "Research fifty agencies and
-- draft outreach for each" is not a long task in LeadRail today — it is a
-- 16-step turn that gets force-finalled, and on a scheduled re-run it starts
-- again from zero, because runDueScheduledTasks calls runAgent with
-- `message: task.prompt` and NO conversationId and NO transcript. What survives
-- a firing is `last_status` and a truncated `last_result`.
--
-- So "where am I in this task" is RE-DERIVED from a transcript every turn:
-- expensive, lossy, and hard-capped. This makes it STATE — cheap, exact, and
-- unbounded by the step limit.
--
-- The pattern already exists in this codebase. `hermes_jobs.step_index` is
-- exactly this for email sequences: a durable cursor into a multi-step process.
-- LeadRail could already run a DETERMINISTIC multi-step process across ticks
-- and could not run an AGENTIC one. This generalises the cursor.

CREATE TABLE IF NOT EXISTS agent_plans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- The conversation the plan belongs to. Load-bearing for more than display:
  -- standing approval grants (migration 062) are keyed on conversation_id, and
  -- so is memory extraction (061). A plan without one cannot use either, which
  -- is precisely why unattended scheduled runs stall at the first spend gate.
  conversation_id UUID,
  brand_id        TEXT REFERENCES brands(id) ON DELETE SET NULL,

  objective       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',

  -- BUDGETS ARE NOT ADVISORY. A plan that cannot finish must stop, not grind:
  -- an autonomous system retrying forever is how credits get burned on a task
  -- it cannot do. The model may WRITE a plan; only a human may raise these.
  max_steps       INT NOT NULL DEFAULT 200,
  steps_used      INT NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,

  created_by      TEXT,
  last_run_at     TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- draft     -> written, awaiting the operator's go-ahead (plan mode)
  -- running   -> approved and being worked
  -- blocked   -> a step needs a human (an approval, a decision)
  -- done      -> every step resolved
  -- cancelled -> stopped by a human
  -- failed    -> budget exhausted or a step exceeded its attempts
  CONSTRAINT agent_plans_status_check
    CHECK (status IN ('draft', 'running', 'blocked', 'done', 'cancelled', 'failed'))
);

CREATE TABLE IF NOT EXISTS agent_plan_steps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID NOT NULL REFERENCES agent_plans(id) ON DELETE CASCADE,
  seq             INT NOT NULL,
  title           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending',
  result          TEXT,
  -- Three failures on the same step blocks it and tells a human. Without this a
  -- plan re-attempts the impossible until its budget is gone.
  attempts        INT NOT NULL DEFAULT 0,
  blocked_reason  TEXT,
  -- Set when the step halted on a sensitive action, so resuming continues FROM
  -- that step rather than restarting the plan.
  approval_id     UUID REFERENCES approvals(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ,
  finished_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT agent_plan_steps_status_check
    CHECK (status IN ('pending', 'in_progress', 'done', 'blocked', 'skipped')),
  CONSTRAINT agent_plan_steps_seq_unique UNIQUE (plan_id, seq)
);

-- AT MOST ONE STEP IN PROGRESS PER PLAN, enforced by the database rather than
-- by convention. A plan with two active steps has no answer to "what are you
-- doing", which is the entire value of keeping a cursor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_plan_steps_single_active
  ON agent_plan_steps(plan_id)
  WHERE status = 'in_progress';

-- The runner's queue: plans with work left, oldest first.
CREATE INDEX IF NOT EXISTS idx_agent_plans_runnable
  ON agent_plans(account_id, last_run_at NULLS FIRST)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_agent_plans_conversation
  ON agent_plans(conversation_id) WHERE conversation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_agent_plan_steps_plan
  ON agent_plan_steps(plan_id, seq);

-- Phase 4: give a scheduled task somewhere to keep its conversation, so its
-- runs stop being cold starts and can reach grants and memory like any other.
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS conversation_id UUID;
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS active_plan_id UUID REFERENCES agent_plans(id) ON DELETE SET NULL;

COMMENT ON TABLE agent_plans IS
  'A durable, budgeted task list for agentic work that outlives one request. Status draft = written but not yet approved (plan mode).';
COMMENT ON COLUMN agent_plans.max_steps IS
  'Hard ceiling on total agent steps across every resumption. The model may not raise it.';
COMMENT ON INDEX idx_agent_plan_steps_single_active IS
  'At most one in_progress step per plan — the cursor invariant.';

ALTER TABLE agent_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_plan_steps ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.agent_plans FROM anon, authenticated;
REVOKE ALL ON public.agent_plan_steps FROM anon, authenticated;
