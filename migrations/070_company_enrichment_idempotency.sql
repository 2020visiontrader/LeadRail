-- 070_company_enrichment_idempotency.sql
--
-- Fixes a real defect in lib/enrichment-jobs.ts: enqueueCompanyEnrichment's
-- header comment claims "the partial unique index (status in pending|running)
-- makes a duplicate insert a no-op" and catches Postgres 23505 to report
-- 'already in flight'. That claim is false for companies. The only such index
-- ever created — uniq_enrichment_job_live_contact, in
-- 011_typed_sequencing.sql — covers contact_id only:
--
--   CREATE UNIQUE INDEX IF NOT EXISTS uniq_enrichment_job_live_contact
--     ON enrichment_jobs(contact_id) WHERE status IN ('pending','running')
--       AND contact_id IS NOT NULL;
--
-- There has never been an equivalent for company_id, so 23505 can never fire
-- for a company job and the same company can be queued for enrichment
-- repeatedly — each duplicate is a paid Apollo API call. This migration adds
-- the missing mirror index so the guarantee the code already claims actually
-- holds for companies too.
--
-- Verified against production (2026-08-27): enrichment_jobs holds 9 rows, all
-- status='cancelled' — no live (pending/running) rows exist for any
-- company_id, so nothing conflicts and this applies cleanly today.
--
-- DETERMINISTIC BY CONSTRUCTION, not conditional. An earlier draft of this
-- migration wrapped CREATE UNIQUE INDEX in a DO block that caught
-- unique_violation and downgraded it to a NOTICE. That was rejected on
-- review, correctly: on a database that *did* have duplicate live company
-- jobs, that version would have let the migration report success, left
-- uniq_enrichment_job_live_company uncreated, and left
-- lib/enrichment-jobs.ts's comments claiming a guarantee that isn't there —
-- reproducing, one layer down, the exact defect this migration exists to
-- fix (a documented guarantee with no index behind it), and harder to catch
-- because the migration record says it ran clean.
--
-- Instead: resolve duplicates first, in SQL, then create the index with
-- nothing catching its failure. For each company_id with more than one live
-- (pending/running) row, keep the earliest by created_at and cancel the
-- rest, recording why. After that UPDATE, no two live rows can share a
-- company_id, so CREATE UNIQUE INDEX cannot fail on that account. If it
-- fails anyway (schema drift, a concurrent writer racing the migration,
-- anything unanticipated), nothing here catches it — migrations/push.ts
-- runs every numbered migration as one batch and an uncaught error aborts
-- that whole batch, which is the correct outcome: the index either exists,
-- or the migration visibly failed and someone looks. There is no third
-- state where it silently doesn't exist while the code says it does.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (PARTITION BY company_id ORDER BY created_at ASC, id ASC) AS rn
  FROM enrichment_jobs
  WHERE company_id IS NOT NULL AND status IN ('pending', 'running')
)
UPDATE enrichment_jobs
SET status = 'cancelled',
    error = 'de-duplicated by migration 070 (uniq_enrichment_job_live_company): superseded by an earlier live job for the same company_id',
    updated_at = NOW()
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_enrichment_job_live_company
  ON enrichment_jobs (company_id)
  WHERE status IN ('pending', 'running') AND company_id IS NOT NULL;
