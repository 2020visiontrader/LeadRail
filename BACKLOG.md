# Backlog — dated risks and unfinished wiring

Things that are known, scoped, and not yet done. Each carries a date or a
trigger, because the failure mode this file exists to prevent is a real risk
living only in a conversation nobody re-reads.

Recurring pattern behind most of these: **something is written but never read,
or configured in prose but never in a config file.** Thirteen instances found so far.
When adding an entry, say what proves it is done — a passing test, a row in a
table, a non-401 log line — not "wire it up".

Last reviewed: 2026-08-30

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

## 4. `stream_options` — ANSWERED from production, 2026-08-28

The entry said this "cannot be closed from a sandbox" and needed four curls run
with real keys and live egress. It needed neither: the app has been serving
real traffic, so `ai_usage` already held the answer.

Token capture on successful calls, by ladder tier (`model_label`):

| tier | ok calls | with tokens | % |
|---|---:|---:|---:|
| **zoask** | **168** | **0** | **0** |
| openrouter | 107 | 107 | **100** |
| nim | 6 | 6 | **100** |
| opencode | 0 | 0 | — |
| huggingface | 0 | 0 | — |

**`stream_options: { include_usage: true }` works.** Where a provider honours
it, capture is 100%, not partial — OpenRouter 107/107, NIM 6/6. That is the
verification this entry was waiting for, and it is stronger evidence than four
curls: it is every real call the system has made.

**The gap is Zo Ask.** It is the first ladder tier and answers more calls than
every other tier combined — 168 of 281 — and it reports usage on none of them.
So roughly 60% of successful traffic is unmeasured for tokens and therefore for
cost. Nothing is broken in the code; the provider does not supply it.

**Done when:** either Zo Ask returns usage and rows carry tokens, or the
absence is recorded explicitly so a NULL meaning "this provider does not supply
usage" is distinguishable from one meaning "we did not look". Today they are
the same value, and that ambiguity is the actual defect worth fixing.

### A correction, recorded because it nearly became a false entry

An earlier version of this section claimed `provider_id` was NULL on 86% of
successful rows and called it a large attribution defect. **That was wrong.**
NULL there is deliberate and documented at `lib/ai/router.ts:172` — a ladder
tier is not one of the account's configured models, and pointing the row at one
would misattribute it. Attribution was never missing; it lives in
`model_label`. The false reading came from joining `ai_usage` to `ai_providers`,
which only covers registry models and silently collapsed all ladder traffic
into "(unknown)". The join was wrong, not the data — the same failure mode as
grepping `export async function DELETE` against a codebase that writes
`export const DELETE = withApi(...)`.

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
- ~~**Attachment provenance does not survive a reload.**~~ **RESOLVED
  2026-08-28** (migration 076, `93a588d`). Transcript entries now carry stable
  ids, and `attachment_bindings` records which attachment belongs to which
  message/conversation/task — outside the transcript body, so one file can bind
  to several messages without duplicating content and a release is a row update
  rather than a transcript rewrite.
  The wire/storage split is the part to preserve: `ChatMessage` is still
  exactly `{ role, content }`, and `lib/agent/transcript-store.ts`
  (`toWireMessages`) strips the id before every provider call. A test pins that
  no stored message reaches a provider unwrapped. Do not "simplify" the id onto
  `ChatMessage` — it would ship into every model payload.
  Verified against production, not `success: true`: 2 tables created, **397 of
  397** transcript entries carry an id, 0 duplicates, 5 CHECK constraints, and
  the partial unique index `uniq_attachment_binding_live` present. Before
  applying, the backfill was dry-run inside a forced-rollback transaction —
  397 in, 397 out, order and roles unchanged, nothing persisted.
  **Idempotency was verified separately and matters more than it looks:** the
  backfill was re-run against already-migrated data and changed 0 ids. Had it
  re-minted, a redeploy re-running migrations would have orphaned every
  `attachment_bindings.message_id`.
  `attachment_evidence` exists as SCHEMA ONLY — nothing writes it, and its own
  table comment says so. Do not build a reader against it until a writer
  exists, and do not read its presence as evidence capture being live.

- **9 stale `enrichment_jobs` cancelled** on 2026-08-27 (queued 2026-08-09/10,
  never drained). Company enrichment only, no outbound send. Cancelled rather
  than drained so the first real tick would not spend Apollo credits on
  18-day-old intent. Re-enqueue on demand.

---

## 5. Fan-out removal — three loose ends, 2026-08-30

The coordinator fan-out (`resolveCoordinatorFanout`, `runFanoutDelegates`,
`selectPersonasForRequest`, `ROLE_SIGNALS`, the synthesis pass) is deleted.
`askSpecialist` is now the only way to spawn a sub-agent. Three things it left
behind, none of them breaking, all of them the "written but never read" pattern
in one direction or the other.

**5a. ~~`AgentConsole` parallel-step branch now has no producer.~~ — RESOLVED 2026-08-30**
Deleted together: the `parallel`/`key` guard and spread in `AgentConsole.tsx`'s
event reducer, `Step.parallel`/`Step.key`, `AgentEvent`'s `parallel`/`key`
fields in `lib/agent/loop.ts`, and `tests/fanout-trace.test.ts`. Confirmed by
grep that nothing in `lib/` or `app/` ever set `parallel: true` or a
`delegate:` key before deleting.

`src/components/AgentConsole.tsx:952-964` keeps the reducer rule that stops a
`parallel` step from being auto-resolved by the next event. Nothing in `lib/`
or `app/` emits `parallel: true` or a `delegate:<id>` key any more — the
fan-out was its only producer, and `askSpecialist` runs sequentially inside the
step loop. `tests/fanout-trace.test.ts` tests a LOCAL reimplementation of that
branch, so it passes whether or not the real branch is reachable.
Harmless (a defensive branch that never fires), and deliberately not deleted
here: it is UI, and a future concurrent-step feature would want exactly this
rule back.
**Done when:** either something emits `parallel: true` again and the branch is
reachable, or the branch, its `Step.parallel`/`key` fields, and
`tests/fanout-trace.test.ts` are removed together in one change.

**5b. ~~Plans no longer pin a persona.~~ — RESOLVED 2026-08-30**
`lib/agent/persona-routing.ts` (new, pure, no DB imports) is the parser
`harvested-personas.ts` was missing a reader for: `personaSlugsForSkill`
scans a skill's `## Agents Used` section for `**slug**` tokens,
`pickPersonaSlug` picks the one slug named by the most routed skills (ties
broken by routing order) so a turn is never voiced by more than one persona
at once, and `resolvePersona` resolves that slug to a voice — an account's
own enabled, non-coordinator `personas` row beats the harvested template of
the same slug, which beats null. `lib/agent/loop.ts` calls this, in both
`runAgentImpl` and `runAgentStreamImpl`, right after `selectSkillsForTurn`
returns, and only when the turn has no pinned `personaId`/`@mention` of its
own (an explicit pin still wins outright, unchanged). The resolved persona
renders through the same `buildPersonaSystemBlock` a DB-row persona always
used — widened to a minimal `PersonaVoice` shape so a template-sourced
persona needs no second renderer — and lands exactly where `personaBlock`
already sat in the static prompt-cache prefix.
`lib/capabilities/plans.ts` `createPlan` now derives its pin the way this
entry originally asked: from the skills Hermes already routed two lines
above, through the same `pickPersonaSlug` + `resolvePersona`. Because
`plans.personaId` is a DB row FK, only a **row** resolution is pinned — a
template-only match pins nothing rather than inventing a row, so a plan
still degrades to the default assistant exactly when 5b originally described,
just for a narrower and correct reason now.
`lib/agent/harvested-personas.ts` is no longer imported by nothing — it is
read by `resolvePersona`'s template fallback on every turn/plan a routed
skill names a persona for.

*Follow-up hardening, 2026-08-30:* `personaSlugsForSkill` returns every
`**bold**` token in the `AGENTS_USED_WINDOW`, including tokens that are not
persona names at all — script filenames and checklist keys that happen to be
bolded in that window. As of this date, across the 431 harvested skills, 10
such non-persona tokens are known: `schema-generator.py`,
`competitor-scraper.py`, `content-scorer.py`, `tech-seo-auditor.py`,
`keyword_cluster.py`, `lead_theme_named`, `specialist_coverage`,
`roadmap_phased`, `kpi_attached`, `drift_re-measure_scheduled`. This was
latent, not firing (0/431 skills lost their voice to one of these, because a
real persona name happened to appear before the junk token and the
first-appearance tie-break favoured it) but not guaranteed to stay latent —
one upstream edit reordering a bold token could silently kill the voice.
Fixed by giving `pickPersonaSlug` an optional `isEligible?: (slug: string) =>
boolean` predicate; `resolveSkillPersonaForTurn` (`lib/agent/loop.ts`) now
loads `rows` before picking and passes `(slug) =>
Boolean(resolvePersona(slug, rows, HARVESTED_PERSONA_TEMPLATES))`, so an
unresolvable token can never win the count or the tie-break and the pick
falls through to the next-best real candidate instead of giving up.
`personaSlugsForSkill` itself is unchanged and intentionally so — it stays a
faithful parser of what the markdown says; eligibility is the caller's
concern, since a future source may legitimately name a persona this repo
does not have a template or row for yet. The next person reading this
window's parser should expect these 10 tokens (and others like them) to keep
showing up as bold matches — that is normal, not a parser bug.

**5c. `scripts/harvest-personas.ts` does not exist.**
`lib/agent/harvested-personas.ts:2` instructs the reader to regenerate it with
`HARVEST_ROOT=<clone-dir> npx tsx scripts/harvest-personas.ts`. That file is
not in the repo. The 24 templates therefore cannot be regenerated or extended,
and the outreach-side personas are unharvested — while 50 cold-outbound skills
from `growthenginenowoslawski/coldoutboundskills` and 118 from `Citedy/adclaw`
were harvested into `lib/skills/harvested.ts` by the script that DOES exist.
**Done when:** the script exists and a run reproduces the current
`harvested-personas.ts` byte-for-byte before it is used to add anything.

**5d. ~~Two helpers and one budget constant now have tests as their only readers.~~ — RESOLVED 2026-08-30**
Deleted together: `routingTextFor` and `describeMaterial` (and their two
`describe` blocks in `tests/agent-comprehension.test.ts`) from
`lib/agent/comprehension.ts`, and `BUDGET.delegateMaterialChars` (both the
literal and the `budgetsFor()` branch, plus the comments that existed only for
it) from `lib/ai/context-budget.ts`, with the six assertions in
`tests/context-budget.test.ts` that referenced it. `comprehend`,
`sampleAcrossDocument`, `parseUnderstanding`, `attachmentChars` and the rest
are untouched.

Found while verifying 5a-5c, listed separately because each is a live example of
the pattern this file opens with, and none was deleted with the fan-out:
- `routingTextFor` and `describeMaterial` (`lib/agent/comprehension.ts:211,228`)
  built the text `selectPersonasForRequest` scored against and the fan-out's
  trace line. Both are now referenced only by
  `tests/agent-comprehension.test.ts`. `comprehend`, `sampleAcrossDocument` and
  `parseUnderstanding` in the same module ARE still live — the module stays.
- `BUDGET.delegateMaterialChars` (`lib/ai/context-budget.ts:118,217`) existed to
  size `DELEGATE_MATERIAL_CHARS` in the loop, which is deleted. Its only
  remaining readers are the six assertions in `tests/context-budget.test.ts`,
  which now pin a number nothing sizes anything with.
Left in place deliberately: a sub-agent context budget is the obvious thing
`askSpecialist` would want if it ever passes `agentContext` down (it currently
passes none), and deleting the constant plus its tests at the tail end of a
large change trades a real risk for a cosmetic gain.
**Done when:** either `askSpecialist` reads `delegateMaterialChars` to bound
material it passes to a sub-run, or the constant, its `budgetsFor` branch and
those six assertions are deleted together — and likewise for the two helpers
and their two describe blocks.
