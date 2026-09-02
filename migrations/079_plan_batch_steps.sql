-- 079_plan_batch_steps.sql — let one plan step iterate a list across ticks.
--
-- THE PROBLEM. Migration 063 gave a plan a durable cursor across STEPS, but a
-- step itself is still one indivisible unit of work: one runAgent call, one
-- tick. "For each of these 95 leads: research them, draft outreach, send it"
-- cannot be expressed — 95 exceeds MAX_PLAN_STEPS (40), and even at 40 steps,
-- one step per tick at the measured production cadence (~35 minutes across
-- 1,216 ticks / 30 days) would take roughly a day to clear. The work is
-- naturally ONE step ("do this for each lead"), not forty.
--
-- THE FIX. A step may carry `over`: an opaque list of item identifiers (lead
-- ids, company ids, whatever the step is iterating). `cursor` is how far into
-- that list the step has gotten, advanced by a handful of items per tick
-- (lib/plans/runner.ts's ITEMS_PER_STEP_TICK) rather than by the whole list at
-- once — the same "cheap, exact, unbounded by request size" cursor pattern
-- 063 already used for steps, one level down, for items.
--
-- `total` is recorded ONCE, at creation, from `over`'s length — and is never
-- recomputed from `over` later. A step reports progress against what it was
-- GIVEN, not against whatever `over` happens to contain if something were to
-- mutate it (nothing does today, but "total = len(over) forever" is an
-- invariant worth being unable to violate by construction, not by convention).
--
-- THE CAP. `over` is a JSONB array on a row with no size limit of its own —
-- without a ceiling, a plan asking to iterate 100,000 items would be accepted
-- at creation and only fail later (a giant row, a runner that never finishes,
-- a plan that outlives its own TTL). 2000 is chosen deliberately over a
-- smaller "clean" number: at the default ITEMS_PER_STEP_TICK=8 and the
-- measured ~35-minute tick cadence, 2000 items is roughly 250 ticks — days,
-- not hours, which is already past where an operator should be splitting the
-- work into multiple plans rather than one enormous step. The cap exists to
-- keep a single row and a single creation request bounded, not to promise a
-- batch of that size will finish inside the plan's PLAN_TTL_MS (24h default);
-- that trade-off belongs to whoever sizes the batch, and is intentionally left
-- to them rather than silently truncated by the store, which would drop items
-- nobody asked to drop.
ALTER TABLE agent_plan_steps ADD COLUMN IF NOT EXISTS over JSONB;
ALTER TABLE agent_plan_steps ADD COLUMN IF NOT EXISTS cursor INT NOT NULL DEFAULT 0;
ALTER TABLE agent_plan_steps ADD COLUMN IF NOT EXISTS total INT;

-- cursor is a count into `over`; it can never be negative, and can never run
-- past what the step was given. Constraints, not convention, because a runner
-- bug that overshoots the cursor is exactly the kind of thing that should fail
-- loudly at the database rather than silently mis-report "103 of 95 done".
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_plan_steps_cursor_check'
      AND conrelid = 'agent_plan_steps'::regclass
  ) THEN
    ALTER TABLE agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_cursor_check
    CHECK (cursor >= 0 AND (total IS NULL OR cursor <= total));
  END IF;
END $$;

-- `total` exists ONLY to describe `over` at creation time, so the two rise and
-- fall together: a step is either an ordinary single-shot step (both NULL) or
-- a batch step (both set). A row with one but not the other is a state this
-- schema does not have a meaning for.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_plan_steps_batch_consistency_check'
      AND conrelid = 'agent_plan_steps'::regclass
  ) THEN
    ALTER TABLE agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_batch_consistency_check
    CHECK ((over IS NULL) = (total IS NULL));
  END IF;
END $$;

-- The creation-time cap described above. Enforced here too (not only in
-- lib/plans/store.ts) so nothing that ever writes this table directly — a
-- future migration, a console fix — can silently exceed it either.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_plan_steps_over_cap_check'
      AND conrelid = 'agent_plan_steps'::regclass
  ) THEN
    ALTER TABLE agent_plan_steps
    ADD CONSTRAINT agent_plan_steps_over_cap_check
    CHECK (over IS NULL OR jsonb_array_length(over) <= 2000);
  END IF;
END $$;

-- Atomic cursor advance, mirroring claim_webhook_deliveries / claim_due_enrollments
-- (012, 011): a plain supabase-js `.update()` cannot express "add p_by to the
-- CURRENT value and decide the resulting status from it" as a single
-- conditional round trip, so read-then-write in application code would race
-- two concurrent ticks. This function is that one round trip.
--
-- Guarded by `WHERE status = 'in_progress'`: only the tick that actually holds
-- the step (via the existing claimStep conditional update) can ever advance
-- it, which is the same "one update returns a row, the other returns none"
-- discipline claimStep already relies on for the single-active invariant — no
-- new locking primitive, the same one, one level down.
--
-- On every successful advance, `attempts` resets to 0. This is the piece that
-- makes MAX_STEP_ATTEMPTS count CONSECUTIVE FAILED TICKS rather than total
-- ticks: claimStep increments `attempts` on every claim (unchanged, existing
-- behaviour), so a batch step that keeps making forward progress has its
-- counter zeroed right back out after each successful tick and can never
-- accumulate toward the block threshold — only a run of ticks that make NO
-- progress does. Without this reset, a 95-item job at 8 items/tick would hit
-- MAX_STEP_ATTEMPTS (3) on its third tick and block itself despite nothing
-- having failed.
--
-- Status is left `in_progress` when the advance reaches `total` (the caller,
-- lib/plans/runner.ts, transitions it to `done` via completeStep immediately
-- after, the same way a normal step's completion already works) and set back
-- to `pending` otherwise, so a crashed or merely-unfinished tick's step is
-- re-claimable next tick rather than stuck in_progress forever.
CREATE OR REPLACE FUNCTION advance_plan_step_cursor(p_step_id UUID, p_by INT)
RETURNS TABLE(new_cursor INT, step_total INT) AS $$
BEGIN
  RETURN QUERY
  UPDATE agent_plan_steps s
     SET cursor = LEAST(s.cursor + GREATEST(p_by, 0), COALESCE(s.total, s.cursor + GREATEST(p_by, 0))),
         attempts = 0,
         status = CASE
           WHEN s.total IS NOT NULL
             AND LEAST(s.cursor + GREATEST(p_by, 0), s.total) >= s.total
           THEN s.status
           ELSE 'pending'
         END,
         updated_at = NOW()
   WHERE s.id = p_step_id AND s.status = 'in_progress'
  RETURNING s.cursor, s.total;
END;
$$ LANGUAGE plpgsql;

COMMENT ON COLUMN agent_plan_steps.over IS
  'Opaque item identifiers this step iterates, one slice per tick. NULL for an ordinary single-shot step. Capped at 2000 entries at creation (see agent_plan_steps_over_cap_check).';
COMMENT ON COLUMN agent_plan_steps.total IS
  'Item count at creation time (over''s length, frozen). Progress is reported against THIS, never recomputed from over.';
COMMENT ON COLUMN agent_plan_steps.cursor IS
  'How many of `over`''s items are done. Advanced only via advance_plan_step_cursor(), never by a direct read-then-write.';
COMMENT ON FUNCTION advance_plan_step_cursor IS
  'Atomic per-tick cursor advance for a batch plan step. Resets attempts to 0 on success so MAX_STEP_ATTEMPTS counts consecutive failed ticks, not total ticks worked.';
