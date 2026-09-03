-- 084_scheduled_tasks_claim.sql — claim scheduled tasks before running them.
--
-- THE GAP. runDueScheduledTasks() (lib/scheduled/store.ts) selects every
-- enabled task with next_run_at <= now and runs each one straight through a
-- full agent turn, with no claim of any kind. It is reachable from TWO
-- callers — the hermes tick (app/api/hermes/tick/route.ts) and the standalone
-- app/api/scheduled-tasks/run-due route, wired for an external scheduler —
-- so an overlapping cron and tick can both select the same due row and both
-- run it: two full agent turns for one task, possibly two sends of whatever
-- that task's prompt asks for.
--
-- THE FIX, SAME SHAPE AS claimStep (lib/plans/store.ts, migration 063's
-- idx_agent_plan_steps_single_active). A conditional UPDATE guarded on the
-- row's own current state is the actual concurrency control — Postgres
-- serializes it at the row, so only one of two racing callers can ever see
-- their UPDATE return a row. The partial unique index below is the same
-- belt-and-suspenders backstop claimStep's header comment describes: if two
-- claims somehow both passed the WHERE clause (they cannot, but the index
-- makes that a constraint the database enforces rather than a hope), the
-- second INSERT/UPDATE-into-'running' fails loudly at the database instead of
-- silently doubling the run.
--
-- STALENESS. Unlike agent_plan_steps' in_progress (cleared by the plan
-- runner's own next tick either way), a scheduled task's run_state has no
-- guaranteed unclaim if the process running it crashes or is killed mid-turn
-- — runDueScheduledTasks' per-task try/catch normally releases the claim in
-- its `finally`-equivalent update, but a hard process kill skips that. A task
-- claimed and never released would otherwise never run again. claimed_at
-- lets the store treat a 'running' claim older than a threshold as
-- reclaimable (lib/scheduled/store.ts's SCHEDULED_CLAIM_STALE_MS) — the same
-- staleness escape hatch running_since already uses (migration 072), applied
-- here for the same reason: a crash must not create a permanently stuck row.

ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS run_state TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'scheduled_tasks_run_state_check'
      AND conrelid = 'scheduled_tasks'::regclass
  ) THEN
    ALTER TABLE scheduled_tasks
      ADD CONSTRAINT scheduled_tasks_run_state_check CHECK (run_state IN ('idle', 'running'));
  END IF;
END $$;

-- Backstop, same role as idx_agent_plan_steps_single_active: a claimed row
-- (id, run_state='running') can exist at most once, enforced by the database
-- rather than by convention.
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_tasks_single_claim
  ON scheduled_tasks(id)
  WHERE run_state = 'running';

COMMENT ON COLUMN scheduled_tasks.run_state IS
  'idle | running. Set to running by a conditional claim (lib/scheduled/store.ts claimScheduledTask) before a due task runs, and back to idle when the run finishes or errors, so two concurrent callers (the hermes tick and the standalone /api/scheduled-tasks/run-due route) cannot both run the same due task.';
COMMENT ON COLUMN scheduled_tasks.claimed_at IS
  'When run_state was last set to running. A claim older than SCHEDULED_CLAIM_STALE_MS (lib/scheduled/store.ts) is treated as abandoned (the process that claimed it died mid-run) and may be reclaimed, the same staleness escape hatch agent_conversations.running_since uses (migration 072).';
