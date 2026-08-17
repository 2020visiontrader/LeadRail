-- 043_scheduled_brand.sql — Venture (brand) scope for the two UNATTENDED agent
-- callers, so a background run can be grounded the same way a chat turn is.
--
-- Packet 3.1 names this file "040_scheduled_brand.sql", but 040/041/042 were
-- taken by later migrations before this packet ran; the number is bumped, the
-- content is the packet's.
--
-- Why: lib/scheduled/store.ts and lib/pipeline/store.ts call runAgent with no
-- agentContext. loadAgentContext() keys the venture section off a brandId, and
-- neither table had one — so grounding had nothing to scope to. Nullable by
-- design: an existing row without a venture still runs, just account-scoped.
--
-- Column type is TEXT, not the packet's UUID: `brands.id` is TEXT in
-- 001_schema.sql and every brand_id in this schema follows it (004/005/006).
-- A UUID column here would fail to create the foreign key.
--
-- Both columns are ON DELETE SET NULL rather than the CASCADE used elsewhere:
-- deleting a venture must not silently delete an account's schedule or its
-- run history — the run simply degrades to account-wide grounding.
--
-- Note on last_status: 027_scheduled_tasks.sql declares no CHECK constraint on
-- scheduled_tasks.last_status (only on `interval`), so the new
-- 'needs_approval' value needs no constraint change — only the column comment
-- below, which documents the widened set.
-- Idempotent; safe to re-run.

ALTER TABLE scheduled_tasks
  ADD COLUMN IF NOT EXISTS brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL;

ALTER TABLE content_pipeline_runs
  ADD COLUMN IF NOT EXISTS brand_id TEXT REFERENCES brands(id) ON DELETE SET NULL;

COMMENT ON COLUMN scheduled_tasks.brand_id IS
  'Optional venture this task runs for; grounds the background run (lib/agent/context.ts).';
COMMENT ON COLUMN content_pipeline_runs.brand_id IS
  'Optional venture this run is for; grounds each stage (lib/agent/context.ts).';
COMMENT ON COLUMN scheduled_tasks.last_status IS
  'ok | needs_approval | error | NULL (never run). needs_approval means the run '
  'proposed a sensitive action and stopped — the approvals row id is in last_result.';
