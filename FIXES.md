# Backend Reconciliation — Fixes Applied

Root cause: Sprint 1 schema and Sprints 2–5 code were built to two different
mental models and never reconciled. Most write paths targeted columns/tables
that did not exist. This pass makes the **DB schema the source of truth** and
aligns all code to it, closes the security holes, and builds the missing routes.

## P0 — fixed
- Contact score: DB column standardized to `contacts.score` (was `engagement_score`);
  types/UI/Hermes all read `score`. Migration `003` renames it in-place.
- `email_campaigns` insert now includes `contact_id` (NOT NULL) + subject/body.
- Brevo webhook writes real columns (`contact_id`, `event_data`, `created_at`);
  resolves contact by email.
- Hermes: `hermes_sequences` + `hermes_jobs` tables and `increment_contact_score`
  RPC now exist. Engine rewritten from `setTimeout` day-delays to a durable job
  queue drained by `POST /api/hermes/tick` (cron-safe on serverless).
- Added `app/api/outreach/send` (Hermes `send_email` target) and
  `app/api/leads/[id]` (frontend PATCH/DELETE target) — both previously 404.
- RLS enabled on all tables (no anon policies). Server uses
  `SUPABASE_SERVICE_ROLE_KEY`; browser anon key can no longer read/write the DB.
- Mass-assignment/IDOR: POST/PATCH now whitelist + validate input; mutating
  routes guarded by `APP_API_SECRET` bearer token when set.

## P1 — fixed
- 4 stub routes (`outreach`, `content`, `campaigns`, `integrations`) now do real
  DB work. Added `ad_campaigns` table to back `/api/campaigns`.
- Webhook routes wired: `/api/webhooks/{brevo,postiz,meta}` with secret/HMAC
  verification (Meta X-Hub-Signature-256 + verify handshake).
- `content_calendar` type realigned to schema (`post_body`/`scheduled_for`/`media_urls`).
- Meta host corrected to `graph.facebook.com`; video path uses `media_type=REELS`
  with container status polling.
- `withRetry` now wraps Brevo/Postiz/Meta send paths (no longer dead code).
- `scoring.ts` keys realigned to the Segment union and invoked on lead creation.

## P2 — fixed
- Sanitized error responses (no raw DB messages leaked); validation returns 400.
- Pagination limit capped; `dbReady()` surfaced in integration status.

## Verification done
- `tsc --noEmit`: clean.
- `next build`: green (9 pages, 12 dynamic API routes).
- Runtime smoke: `GET /api/integrations` returns JSON; `GET /api/leads` → 400 without brandId.

## NOT verified (needs live Supabase)
Runtime DB behavior is unproven because I do not have Supabase credentials here.
Before this works end-to-end:
1. Provision Supabase; set `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
   (and anon key), plus `APP_API_SECRET`.
2. Apply migrations in order: `001_schema.sql` (fresh) OR `003_reconcile.sql`
   (if the original 001 was already applied), then `002_seed.sql`.
3. Schedule a cron to `POST /api/hermes/tick` (Vercel Cron or Supabase pg_cron).

## Known limitation
Browser-originated mutations (leads page PATCH) can't hold `APP_API_SECRET`
safely. A user session/auth layer is still needed for production multi-user use;
out of scope for this reconciliation pass.
