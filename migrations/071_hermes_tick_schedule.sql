-- ===========================================================================
-- 071_hermes_tick_schedule.sql — schedule POST /api/hermes/tick via pg_cron.
--
-- THE BUG THIS CLOSES. app/api/hermes/tick/route.ts drains hermes_jobs,
-- sequence_enrollments, enrichment_jobs, webhook_deliveries, scheduled_tasks,
-- memory extraction and plan steps, then runs retention, account purges and
-- reward maturation. It has been requested exactly ONCE in this database's
-- lifetime — 2026-08-01 — and that request returned 401. It has never
-- executed. There was no wrangler.toml, no vercel.json, no CI workflow, no
-- pg_cron job. FIXES.md and the route's own comment both describe "schedule
-- this" as an intention; neither is a configuration a scheduler reads. See
-- BACKLOG.md §2 for the full audit trail.
--
-- WHAT THIS MIGRATION DOES. Enables pg_cron + pg_net (Supabase's supported
-- in-database scheduler + HTTP client) and schedules a job that POSTs to this
-- app's /api/hermes/tick every 5 minutes, authenticated the same way any other
-- caller must be: requireAuth() in lib/http.ts reads APP_API_SECRET and
-- requires `Authorization: Bearer <secret>` — no other header name, no other
-- scheme. Getting that wrong is exactly how the one real request on record
-- came back 401, so this migration matches it precisely rather than guessing.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--   * It does not hardcode APP_API_SECRET anywhere in this file, in a
--     default, or in a comment. The dispatch function below reads it from
--     Supabase Vault (vault.decrypted_secrets) at RUN TIME, every run. The
--     operator populates the vault entry out of band — see docs/scheduling.md
--     for the exact SQL. This file creates no vault entry and no secret
--     value; there is nothing here to leak into git history.
--   * It does not guess the app's base URL. Same mechanism, same vault, a
--     second entry — see below.
--   * It is not applied by this change. Writing the migration and running it
--     against production are different actions with different blast radii;
--     the second belongs to whoever holds the production credential. See
--     docs/scheduling.md for the apply + verify steps.
--
-- FAIL LOUD, NOT SILENT. Before this migration, "configured but not working"
-- looked identical to "never configured" — a cron.job row would exist either
-- way. hermes_tick_dispatch() below RAISEs on either secret being absent, so
-- a misconfigured schedule shows up as a FAILED row in cron.job_run_details
-- with a message naming exactly what's missing, not as a job that quietly
-- posts with no Authorization header and racks up 401s nobody notices.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Extensions. Both ship with Supabase; enabling is idempotent.
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- ---------------------------------------------------------------------------
-- Dispatch function. Reads the secret and the base URL from Vault on every
-- invocation (not once, not cached) so rotating either value in the vault
-- takes effect on the very next tick with no migration and no redeploy.
--
-- Vault entries this function expects (create out of band — see
-- docs/scheduling.md; NOT created here):
--   name = 'hermes_tick_api_secret'  -> same value as the app's APP_API_SECRET
--   name = 'hermes_tick_base_url'    -> e.g. https://app.example.com (no
--                                        trailing slash; this function trims
--                                        one if present)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.hermes_tick_dispatch()
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  v_secret     text;
  v_base_url   text;
  v_request_id bigint;
BEGIN
  SELECT decrypted_secret INTO v_secret
    FROM vault.decrypted_secrets
   WHERE name = 'hermes_tick_api_secret'
   LIMIT 1;

  IF v_secret IS NULL OR btrim(v_secret) = '' THEN
    RAISE EXCEPTION
      'hermes_tick_dispatch: Vault secret "hermes_tick_api_secret" is not set. '
      'requireAuth() in lib/http.ts rejects any call without a matching '
      'Authorization: Bearer header, so this job refuses to POST rather than '
      'reproduce the 401 on record from 2026-08-01. Populate the secret — see '
      'docs/scheduling.md — then this will start succeeding on its next run.';
  END IF;

  SELECT decrypted_secret INTO v_base_url
    FROM vault.decrypted_secrets
   WHERE name = 'hermes_tick_base_url'
   LIMIT 1;

  IF v_base_url IS NULL OR btrim(v_base_url) = '' THEN
    RAISE EXCEPTION
      'hermes_tick_dispatch: Vault secret "hermes_tick_base_url" is not set. '
      'This job will not guess the app''s origin. Populate it with the '
      'deployed app''s base URL (e.g. https://app.example.com) — see '
      'docs/scheduling.md.';
  END IF;

  -- Fire-and-forget: net.http_post queues the request and returns a request
  -- id immediately, it does not block waiting for /api/hermes/tick to finish
  -- draining seven subsystems. The row that actually proves success lives in
  -- app_logs (written by the app itself once the handler completes), not in
  -- pg_net's own bookkeeping — see docs/scheduling.md for the verification
  -- query. net._http_response is still useful for transport-level failures
  -- (DNS, TLS, connection refused) that never reach the app at all.
  SELECT net.http_post(
    url     := rtrim(v_base_url, '/') || '/api/hermes/tick',
    headers := jsonb_build_object(
                 'Authorization', 'Bearer ' || v_secret,
                 'Content-Type', 'application/json'
               ),
    body    := '{}'::jsonb,
    timeout_milliseconds := 55000
  ) INTO v_request_id;
END;
$$;

COMMENT ON FUNCTION public.hermes_tick_dispatch() IS
  'pg_cron target for the hermes-tick-every-5-min job. Reads APP_API_SECRET '
  'and the app base URL from Vault at call time and RAISEs (visible in '
  'cron.job_run_details as a failed run) if either is unset, instead of '
  'POSTing unauthenticated. See migrations/071_hermes_tick_schedule.sql and '
  'docs/scheduling.md.';

-- ---------------------------------------------------------------------------
-- Schedule. Idempotent: re-running this migration replaces the prior job
-- definition by name rather than accumulating duplicate schedules.
--
-- Every 5 minutes is a starting point, not a measured value — see
-- docs/scheduling.md for what would justify changing it.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'hermes-tick-every-5-min') THEN
    PERFORM cron.unschedule('hermes-tick-every-5-min');
  END IF;
END $$;

SELECT cron.schedule(
  'hermes-tick-every-5-min',
  '*/5 * * * *',
  $$SELECT public.hermes_tick_dispatch();$$
);
