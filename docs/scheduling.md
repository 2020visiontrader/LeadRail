# Scheduling `/api/hermes/tick`

`POST /api/hermes/tick` drains seven subsystems (hermes jobs, sequence
enrollments, enrichment jobs, webhook deliveries, scheduled tasks, memory
extraction, plan steps) and then runs retention, account purges and reward
maturation. It has been requested exactly **once** in this database's
lifetime — 2026-08-01 — and that request returned **401**. It has never
executed. See `BACKLOG.md` §2 for the full audit trail.

`migrations/071_hermes_tick_schedule.sql` schedules it via Supabase
`pg_cron` + `pg_net`. This document is the operator's checklist for making
that migration actually do something, and for proving that it did.

**The migration has not been applied.** Writing it and running it against
production are different actions with different blast radii; applying it
requires a production credential this repo does not hold. Everything below
is what the operator does after reading the migration.

---

## 1. Put the secret and base URL in Vault

The dispatch function (`public.hermes_tick_dispatch()`, created by the
migration) reads two values from Supabase Vault at **run time**, on every
tick — not once, not cached, not baked into the migration. Nothing in the
migration file or in this repo's git history contains either value.

Run this in the Supabase SQL editor (or via `psql`/the CLI) **as an operator
with production access**, after connecting to the project's database:

```sql
-- The same value the app's environment carries as APP_API_SECRET.
-- lib/http.ts's requireAuth() rejects any request whose Authorization
-- header doesn't match this exactly, so paste the real production value —
-- not a placeholder — before this job can succeed.
select vault.create_secret(
  'REPLACE_WITH_THE_REAL_APP_API_SECRET_VALUE',
  'hermes_tick_api_secret',
  'Bearer token hermes_tick_dispatch() sends to POST /api/hermes/tick. Must match the app''s APP_API_SECRET exactly.'
);

-- The deployed app's origin. No trailing slash — the function trims one if
-- present, but keep it clean. This is the app's real public base URL, not a
-- guess: e.g. https://app.example.com.
select vault.create_secret(
  'https://REPLACE_WITH_THE_REAL_APP_BASE_URL',
  'hermes_tick_base_url',
  'Base URL hermes_tick_dispatch() POSTs /api/hermes/tick against.'
);
```

To rotate either value later (key rotation, a domain change), **do not**
re-run `vault.create_secret` with the same name — it errors on a duplicate
name. Update in place instead:

```sql
select vault.update_secret(
  (select id from vault.decrypted_secrets where name = 'hermes_tick_api_secret'),
  'THE_NEW_VALUE'
);
```

The next scheduled run picks up the new value automatically — no migration,
no redeploy.

---

## 2. Apply the migration

This repo's migrations are idempotent and applied in numeric order by
`migrations/push.ts` (see that file's header — it reads `migrations/NNN_*.sql`
directly; `apply_all.sql` is deprecated and empty). From the repo root, with
either `SUPABASE_ACCESS_TOKEN` + `SUPABASE_PROJECT_REF` or `DATABASE_URL` set
to the **production** project:

```sh
bun run migrations/push.ts
```

This re-applies every numbered migration, including 001–070, which is safe
because all of them are idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN
IF NOT EXISTS`, and 071 unschedules-then-reschedules its own cron job by
name). It is still a production DDL action — treat it like one.

If you'd rather apply only 071, paste its contents into the Supabase SQL
editor directly. Either way, do this only after step 1 — applying the
migration before the vault is populated is harmless (the job will simply fail
loudly on its first few runs, per §4 below) but there's no reason to watch
that happen.

---

## 3. How to verify it actually worked

**A row in `cron.job` proves the job is scheduled. It does not prove it is
working.** This is not a hypothetical distinction — it is exactly what
already happened once in this database: the one real request against
`/api/hermes/tick` on record returned 401, which is precisely how a
scheduler can look fully configured while nothing behind it succeeds. Do not
stop at "the job exists."

The correct check is a row in `app_logs` for route `/api/hermes/tick` with
**status 200**, written *after* you applied the migration and populated the
vault:

```sql
select id, route, status, duration_ms, created_at
from app_logs
where route = '/api/hermes/tick'
order by created_at desc
limit 20;
```

- **No rows at all, ever:** the job either isn't scheduled, isn't
  authenticated, or the app never received the request. Check
  `cron.job_run_details` (§4) first.
- **Rows, but every `status` is 401:** the vault secret
  `hermes_tick_api_secret` doesn't match the app's live `APP_API_SECRET`.
  Re-check step 1 — this is the exact failure mode that motivated writing
  this migration in the first place, so don't assume it can't recur.
- **Rows with `status = 200`:** confirmed working. Spot-check the response
  shape too, if you want the full picture — the handler returns a JSON body
  with per-subsystem counts (`legacy`, `sequences`, `enrichment`, `webhooks`,
  `scheduledTasks`, `memory`, `plans`, `purged`, `purgedAccounts`,
  `maturedRewards`) that `withApi` doesn't log verbatim, but a non-zero
  `duration_ms` alongside `status = 200` is a reasonable proxy that real work
  happened rather than an instant no-op.

## 4. Inspecting `cron.job_run_details` for failures

This table is pg_cron's own record of every run, independent of whether the
app was ever reached — it will show the migration's loud failure (§ design
note below) if a vault secret is missing:

```sql
select jrd.status, jrd.return_message, jrd.start_time, jrd.end_time
from cron.job_run_details jrd
join cron.job j on j.jobid = jrd.jobid
where j.jobname = 'hermes-tick-every-5-min'
order by jrd.start_time desc
limit 20;
```

- `status = 'failed'` with a `return_message` naming
  `hermes_tick_api_secret` or `hermes_tick_base_url` — the vault entry is
  missing or empty. This is `hermes_tick_dispatch()`'s deliberate design: it
  `RAISE EXCEPTION`s rather than POSTing without the header, precisely so a
  missing secret shows up here as a loud, legible failure instead of a
  silent 401 that only `app_logs` (§3) would ever reveal.
- `status = 'succeeded'` — the function ran to completion, meaning
  `net.http_post` was called with both a secret and a base URL. It does
  **not** mean the HTTP call itself returned 200; `net.http_post` is
  fire-and-forget from pg_cron's point of view. For transport-level failures
  (DNS, TLS, connection refused, timeout) that never reached the app at all,
  check pg_net's own response log:

```sql
select id, status_code, content, created
from net._http_response
order by created desc
limit 20;
```

A `succeeded` cron run plus a non-2xx or missing row in `net._http_response`
means the request left the database but never landed cleanly — still not the
same thing as the `app_logs` 200 in §3, which is the only check that proves
the app itself did the work.

## 5. How to unschedule

```sql
select cron.unschedule('hermes-tick-every-5-min');
```

Confirm it's gone:

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'hermes-tick-every-5-min';
-- expect 0 rows
```

Re-running `migrations/071_hermes_tick_schedule.sql` (or `push.ts`)
re-creates it.

## 6. Is 5 minutes right?

Every 5 minutes is a starting point picked to match the route comment's
original intent ("every few minutes"), not a measured value. Watch these
before changing it:

- **`cron.job_run_details` run duration** (§4, `end_time - start_time` on the
  cron side is near-instant since `net.http_post` doesn't block; look instead
  at `app_logs.duration_ms` for the route itself). If ticks routinely take
  longer than the interval, runs will overlap — `net.http_post`'s 55s
  `timeout_milliseconds` in the migration caps how long pg_net waits on any
  one call, but overlapping ticks racing the same due-rows is a real
  possibility once volume grows.
- **Queue depth vs. staleness tolerance.** `hermes_jobs`,
  `sequence_enrollments`, `enrichment_jobs`, and `webhook_deliveries` all
  accumulate between ticks. If a 5-minute delay before a sequence step sends,
  or before a webhook retries, is unacceptable for the workload, shorten the
  interval; if the drain is consistently near-empty, 5 minutes is probably
  tighter than necessary and could be relaxed to reduce load.
- **`app_logs` volume.** Every tick writes at least one row; at 5-minute
  intervals that's ~288/day just from this route, on top of the retention
  cliff already tracked in `BACKLOG.md` §1 (the same tick is what performs
  that retention, so once this is working that risk resolves itself — but
  don't shorten the interval without checking that table's growth rate too).

---

## Related: the `stream_options` usage-accounting check

A separate, unrelated verification gap lives in the streaming AI path (see
`BACKLOG.md` §4): `stream_options: { include_usage: true }` is sent on every
provider's streaming request but has never been confirmed to actually return
a usage block from a live endpoint — the dev sandbox has no provider keys and
its egress proxy blocks all five provider hosts.

`scripts/verify-stream-options.sh` closes that gap from anywhere with real
provider keys and live egress. See the script's own header comment for exact
usage; in short:

```sh
ZO_API_KEY=... OPENCODE_API_KEY=... NVIDIA_API_KEY=... \
HUGGINGFACE_API_KEY=... OPENROUTER_API_KEY=... \
  bash scripts/verify-stream-options.sh
```

It is unrelated to `pg_cron`/Vault above — grouped here only because both are
"written but never proven" gaps closed the same way: by giving the operator
an exact, runnable check instead of another paragraph of intent.
