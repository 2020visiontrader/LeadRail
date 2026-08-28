# Backlog — dated risks and unfinished wiring

Things that are known, scoped, and not yet done. Each carries a date or a
trigger, because the failure mode this file exists to prevent is a real risk
living only in a conversation nobody re-reads.

Recurring pattern behind most of these: **something is written but never read,
or configured in prose but never in a config file.** Ten instances found so far.
When adding an entry, say what proves it is done — a passing test, a row in a
table, a non-401 log line — not "wire it up".

Last reviewed: 2026-08-27

---

## 1. `app_logs` retention cliff — ~2026-10-30

**Deadline, not a task.** `app_logs` is trimmed to 90 days by the last step of
`POST /api/hermes/tick`. That endpoint has never run successfully (see §2), so
nothing has ever been trimmed.

Oldest row is 2026-08-01. The table crosses its own 90-day retention line
around **2026-10-30**. Until then `logs_past_retention` reads 0 and the problem
is invisible — an unlit fuse, not a current fault.

At ~36k rows and one row per API request, growth tracks traffic. Whichever
comes first — the tick gets scheduled, or the cliff arrives — this resolves.
If neither, the table grows without bound and the first symptom will be cost
or query latency, not an error.

**Done when:** a tick run has actually executed the delete, or retention is
enforced somewhere that does not depend on the tick.

## 2. `/api/hermes/tick` has no scheduler — blocks seven subsystems

The route drains `hermes_jobs`, `sequence_enrollments`, `enrichment_jobs`,
`webhook_deliveries`, `scheduled_tasks`, memory extraction and plan steps, then
runs retention, account purges and reward maturation.

It has been requested **once in the lifetime of this database** — 2026-08-01 —
and that request returned **401**. It has never executed. There is no
`wrangler.toml`, no `vercel.json`, no `.github/workflows`, no pg_cron, no
Cloudflare Worker. `FIXES.md:51` lists "Schedule a cron to POST
/api/hermes/tick" under *NOT verified*; the route comment says "Schedule via a
Supabase scheduled function". Both describe an intention. Neither is a
configuration.

Agreed approach: **Supabase `pg_cron` + `pg_net`**. No new platform, no new
credential surface. Requires someone with production access to place
`APP_API_SECRET` where the POST can read it — a credential action, not a code
change.

**Done when:** `app_logs` shows a `/api/hermes/tick` row with status 200.
Verify by querying, not by assuming the schedule took.

## 3. `processDueEnrollments` has no staleness floor

`lib/sequences.ts` selects `.lte('next_run_at', now)` with no lower bound and
no relevance check. Any due-but-unprocessed enrollment is sent regardless of
age. If a drip step came due on day 3 and the drain first runs on day 26, it
sends on day 26.

**Safe today only because `sequence_enrollments` is empty.** That is data luck,
not a safety property, and it expires the moment anyone enrolls a contact into
one of the 6 existing sequences. The window between "someone enrolls" and "the
cron is wired" is a stale-send window into real inboxes.

Scoped separately from §2 on purpose: wiring the scheduler and bounding
staleness are different changes, and bundling them means neither gets tested
properly. Do this one **before** sequences get used, not after.

**Done when:** a test proves an enrollment overdue by more than the floor is
skipped or rescheduled rather than sent, and the floor is configurable.

## 4. `stream_options` unverified against live providers

Token accounting (Fix 3) ships with `stream_options: { include_usage: true }`
on the streaming path, never exercised against a real endpoint — no provider
keys in the dev environment, and the egress proxy 403s all five hosts.

Cannot be closed from a sandbox. Needs the four curls run from anywhere with
real keys and live egress, against each provider that streams.

**Done when:** a real streamed response is confirmed to carry a usage block,
per provider — or the providers that do not are documented here.

---

## Found during the 2026-08-27 tick audit — not yet scoped

- ~~**`agent_conversations` and `agent_memory` are missing from
  `EXPORT_TABLES`.**~~ **RESOLVED 2026-08-27** (`4751e4a`, `da04553`). Turned
  out to be far larger than the two tables: the export covered 20 of 84
  account-scoped tables, and separately leaked `integration_connections.
  secret_encrypted` — the allow-list was under-inclusive on user data and
  over-inclusive on credentials at the same time. Two more defects surfaced
  during review: `sequence_enrollments` and `referrals` were listed for export
  but have no `account_id`, so the bundle had been shipping `{"error": ...}` in
  place of their data and nothing read it; and `approvals.args_encrypted`
  (ciphertext of full tool-call args) escaped the secret pattern.
  Now: every account-scoped table is exported or excluded-with-a-reason, each
  export scope declares real columns, secrets match by pattern including
  `_encrypted`/`_hash`, and drift tests read `migrations/*.sql` so a new
  unclassified table, a missing scope column, or a new secret column turns the
  suite red. Tenant isolation is tested per scope kind.
- ~~**`agent_conversations` has no deletion path at all.**~~ **STALE — CORRECTED
  2026-08-27.** This entry was wrong on all three counts and cost real time
  before being re-checked. The deletion path exists and is sound:
  `migrations/069_conversation_deletion.sql` adds `deleted_at` plus a partial
  index; `app/api/agent/conversations/[id]/route.ts` exports a DELETE handler
  (as `export const DELETE = withApi(...)`, which is why a grep for
  `export async function DELETE` finds nothing — the whole codebase uses the
  wrapper form); `ChatHistory.tsx` has the delete affordance and confirm
  dialog; `tests/conversation-deletion.test.ts` covers it. Account scope is
  applied inside `deleteConversation`'s query and the response is deliberately
  a non-oracle.
  WHAT IS ACTUALLY OPEN, and it is a different defect: soft-delete works, but
  the hard purge never happens. `purge_soft_deleted` has exactly one caller,
  `/api/hermes/tick`, which has no scheduler (§2) and has never executed
  successfully in production. So the confirm dialog's promise — "permanently
  removed after 30 days" — is not currently kept: rows sit with `deleted_at`
  set indefinitely. The migration and its tests are honest about this; the
  user-facing copy is the one surface where the gap leaks out as a promise.
  Closing §2 makes the promise true; until then the copy overstates. Proves
  closed: a scheduled tick run, then `SELECT count(*) FROM agent_conversations
  WHERE deleted_at < now() - interval '30 days'` returning 0 in production.
- **`enqueueCompanyEnrichment` documents an idempotency guarantee it does not
  have.** It relies on a 23505 unique violation, but
  `uniq_enrichment_job_live_contact` indexes `contact_id` only — there is no
  equivalent on `company_id`. Duplicate live company jobs are possible; the
  code's "duplicate insert is a no-op" comment is true for contacts and false
  for companies.
- **9 stale `enrichment_jobs` cancelled** on 2026-08-27 (queued 2026-08-09/10,
  never drained). Company enrichment only, no outbound send. Cancelled rather
  than drained so the first real tick would not spend Apollo credits on
  18-day-old intent. Re-enqueue on demand.
