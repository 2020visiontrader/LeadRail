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

## 1. `app_logs` retention cliff — ~2026-10-30 (premise corrected 2026-08-28)

**Deadline, not a task.** `app_logs` is trimmed to 90 days by the last step of
`POST /api/hermes/tick`.

This entry said "that endpoint has never run successfully (see §2), so nothing
has ever been trimmed." **The first half is now false** — the tick has run 261
times at status 200 (§2), so the trim step executes every five minutes. The
second half is still true, for a different and harmless reason: oldest row is
`2026-08-01 16:06:23Z` and today is 2026-08-28, so at 27 days nothing is yet
past the 90-day line. The delete runs and correctly deletes nothing.

Current size: **38,711 rows**. The cliff is still ~**2026-10-30**.

**Done when:** a tick run executes the delete against rows that are actually
past retention. Note this cannot be observed before the cliff — and that the
same vacuous-proof trap applies here as to `purge_soft_deleted` below: a
delete that runs against zero eligible rows proves the schedule works, not the
delete. Backdate a row in a test and assert it is removed.

## 2. ~~`/api/hermes/tick` has no scheduler~~ — RESOLVED 2026-08-28

**Verified by querying production, which is what this entry demanded.**
`app_logs` holds **261 rows for `/api/hermes/tick` at status 200**, latest
`2026-08-28 06:55:04Z`. The single 401 this entry was written around is still
there, dated `2026-08-01 16:07:35Z`, and is now the only one.

What runs it: `cron.job` id 1, `hermes-tick-every-5-min`, `*/5 * * * *`,
active, calling `public.hermes_tick_dispatch()`. `pg_cron` 1.6.4 and `pg_net`
0.19.5 are installed. The agreed approach was taken as written — no new
platform, no new credential surface.

`cron.job_run_details`: 263 succeeded, 3 failed. The 3 failures are worth
keeping: before the Vault secret existed, the dispatch **refused to POST**
rather than sending an unauthenticated request, and said so — "Vault secret
`hermes_tick_api_secret` is not set. requireAuth() in lib/http.ts rejects any
call without a matching Authorization: Bearer header." A failure that explains
its own cause and declines to do the wrong thing.

**A trap for whoever reads this next.** `cron.job_run_details.status =
'succeeded'` does NOT mean the tick returned 200. `pg_net` is asynchronous:
the job succeeds the moment the request is *queued*, and the HTTP status lands
later in `net._http_response`. Judging this by job status alone would have
called a 401-every-5-minutes loop healthy. Check `app_logs.status`.

Resolved, and my note about it was wrong. The 47 `status = NULL` rows are not
requests at all: they are warn-level log lines emitted *during* a tick —
`ai router: candidate failed` (30) and `ai health: candidate quarantined`
(17). They carry route context but never complete a request, so NULL is the
correct value. Nothing to fix. Recorded because "a logged request nothing can
assert on" was a wrong reading of a correct row.

## 3. ~~`processDueEnrollments` has no staleness floor~~ — RESOLVED

Implemented in `lib/sequences.ts:423-431`, and the entry was already stale when
re-read on 2026-08-28. `staleHoursFloor()` reads `SEQUENCE_STALE_HOURS` and
falls back to `DEFAULT_STALE_HOURS`, so the floor is configurable as required;
`splitStale()` partitions claimed rows; `pauseStaleEnrollments()` pauses the
overdue ones rather than sending them. Applied after the claim so it covers
**both** the `claim_due_enrollments` RPC path and the fallback select — the
gap that would have made it a partial fix.

Proof: `tests/sequence-staleness.test.ts`, 7 tests, green on 2026-08-28.

Still true and worth keeping: `sequence_enrollments` is empty (0 rows) with 6
sequences defined. The urgency this entry claimed has not gone away, it has
inverted — §2 is now closed, so the cron IS wired. The protective gap this
entry relied on ("the window between someone enrolling and the cron being
wired") is shut. The floor is what stands between a first enrollment and a
stale send, which is why it mattered that it was already done.

## 4. `stream_options` — partially answered from production, 2026-08-28

The entry said this "cannot be closed from a sandbox" and needed four curls run
somewhere with real keys and live egress. It did not need curls: the app has
been serving real traffic, so `ai_usage` already holds the answer. Queried it.

Of 754 `chat` rows, 328 succeeded, and only **116 carry token counts**. By
provider, over successful calls:

| provider | ok | with tokens | % |
|---|---:|---:|---:|
| (provider_id NULL) | 281 | 113 | 40.2 |
| NVIDIA NIM | 20 | 3 | 15.0 |
| HuggingFace | 15 | 0 | **0** |
| Zo Ask | 12 | 0 | **0** |
| OpenRouter | 0 | 0 | — |
| OpenCode Go | 0 | 0 | — |

So `stream_options: { include_usage: true }` is **not** yielding usage for most
traffic. HuggingFace and Zo Ask return none at all across 27 successful calls;
NIM returns it 15% of the time. OpenRouter has no successful call to judge by.
That is enough to say token accounting cannot currently be trusted as a cost
basis — without needing the curls.

**A larger defect surfaced while checking.** `provider_id` is NULL on **281 of
328** successful rows — 86%. `ai_usage.provider_id` is the join key for
per-provider cost attribution, so for most traffic there is nothing to attribute
to. The rows are written; the column that makes them readable is not. This is
the house pattern again, and it is worth more than the `stream_options`
question that exposed it: fixing usage reporting is pointless while the
attribution key is absent.

**Done when:** for §4, a provider-by-provider table showing which return usage
on the streaming path, and the ladder either records tokens or records that the
provider does not supply them — a NULL that means "not supplied" must be
distinguishable from one that means "we did not look". For the attribution bug,
`provider_id` non-NULL on new successful `ai_usage` rows, verified by querying.

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
  CORRECTED AGAIN, same day: the paragraph that stood here said the hard purge
  "never happens" because §2 had no scheduler. That was written off the stale
  §2 and is false. The tick has run 261 times at status 200; it calls
  `purge_soft_deleted`; the confirm dialog's "permanently removed after 30
  days" is therefore a promise the system now keeps.
  **Now proven, 2026-08-28.** `agent_conversations` still has 0 rows with
  `deleted_at` set, so the earlier check passed vacuously. Proved it properly
  instead, against the real function in production, inside a `DO` block that
  ends in `RAISE EXCEPTION` so the whole thing rolls back and nothing persists:
  inserted three fixtures on a real account — one soft-deleted 45 days ago, one
  soft-deleted 2 days ago, one active — then called `purge_soft_deleted(30)`.
  Result: `purged_rows=1 | old_deleted=t | recent_kept=t | active_kept=t`.
  Confirmed afterwards that 0 fixtures remained and the conversation count was
  unchanged at 29.
  Three branches, not one, which is what makes it discriminating: a purge that
  deleted everything would fail `recent_kept` and `active_kept`; a purge that
  deleted nothing would fail `old_deleted`. It was not revert-checked in the
  usual way because the only way to break it is to alter a live production
  function, which is not worth the risk when the three-branch form already
  separates the failure modes.
  Worth recording for anyone writing DB proofs here: **no test in this suite
  touches a live database.** `grep -rl "createClient|SUPABASE_URL|pg" tests/`
  returns nothing — every DB test reads `migrations/*.sql` as text or mocks
  with `vi`. So a non-vacuous purge test cannot be written in the harness as it
  stands, and the rollback-in-a-DO-block pattern above is the substitute.
- **`enqueueCompanyEnrichment` documents an idempotency guarantee it does not
  have.** It relies on a 23505 unique violation, but
  `uniq_enrichment_job_live_contact` indexes `contact_id` only — there is no
  equivalent on `company_id`. Duplicate live company jobs are possible; the
  code's "duplicate insert is a no-op" comment is true for contacts and false
  for companies.
- **Attachment provenance does not survive a reload — verified 2026-08-28.**
  `assistant_attachments` binds an upload to `account_id` and a nullable
  `conversation_id`. There is no `message_id` and no run reference. That alone
  would be a modelling gap; the reason it is a real defect is one level deeper.
  There is no `agent_messages` table at all. A conversation's messages live in
  `agent_conversations.transcript` (jsonb), and every element of that array has
  exactly two keys — confirmed by querying every transcript in production:
  `role` and `content`. No id, no timestamp, no attachment refs.
  So there is nothing for an attachment to point AT, and nothing in a message
  that points BACK. While a turn is live the composer holds the binding in
  React state and the chips render correctly. Reopen the conversation and that
  binding is gone: the transcript can say a question was asked, never that a
  file came with it. "Did you actually read my PDF?" is unanswerable after a
  reload, and a rehydrated turn cannot show what it was given.
  Note for whoever scopes this: proposals to "add `message_id` to attachments"
  presume a message table that does not exist. The choice is to give transcript
  entries stable identity, or to record the binding somewhere that survives —
  not to add a foreign key to nothing.
  **Done when:** a conversation with an attachment is reopened from the
  database in a test and the rehydrated turn still names the file it was given.
  Revert-check by stripping the binding and confirming that test goes red.

- **9 stale `enrichment_jobs` cancelled** on 2026-08-27 (queued 2026-08-09/10,
  never drained). Company enrichment only, no outbound send. Cancelled rather
  than drained so the first real tick would not spend Apollo credits on
  18-day-old intent. Re-enqueue on demand.
