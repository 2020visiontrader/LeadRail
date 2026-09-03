# Backlog — dated risks and unfinished wiring

Things that are known, scoped, and not yet done. Each carries a date or a
trigger, because the failure mode this file exists to prevent is a real risk
living only in a conversation nobody re-reads.

Recurring pattern behind most of these: **something is written but never read,
or configured in prose but never in a config file.** Fourteen instances found
so far. The fourteenth: `ai_usage.usage_status` / `usage_source` (migration
075) were written on every insert from the day they shipped and read by
nothing until 2026-09-02, when `getAiUsageSummary` started splitting
estimated tokens out of the reported total on `usage_source`.
When adding an entry, say what proves it is done — a passing test, a row in a
table, a non-401 log line — not "wire it up".

Last reviewed: 2026-09-03

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

**5c. ~~`scripts/harvest-personas.ts` does not exist.~~ — RESOLVED 2026-08-30**
The script exists (commit 241a9ad) and regenerates `lib/agent/harvested-personas.ts`
from two local clones: `indranilbanerjee/digital-marketing-pro` @ fa4ccd0a (24
agents, `agents/<slug>.md`) and `Citedy/adclaw` @ 25bf9601 (5 personas parsed out
of `src/adclaw/agents/persona_templates.py`). Verified the way the "Done when"
below asks: a re-run produced a zero-byte diff against the committed output.
It also fixed a much larger problem than the missing script. The previous
generator kept **3.2%** of each persona — 9,010 characters against 284,003 bytes
upstream, several capped at exactly 500 — so `content-creator` was a
231-character paragraph instead of its 12,909-character framework. Fidelity is
now 95.6% (the remainder is YAML frontmatter, which is not instruction text),
minimum 8,238 characters, and `tests/harvested-personas.test.ts` pins
`instructions.length > 2000` on every digital-marketing-pro entry so the
truncation cannot come back unnoticed.
STILL TRUE, and the reason this section's premise about outreach stands: there
are **no outreach personas in either source**. 27 of the 29 are `domain:
'marketing'`, 2 are `'shared'`, none are `'outreach'`.
`growthenginenowoslawski/coldoutboundskills` ships no `agents/` directory, so
there was never anything upstream to harvest. Outreach personas have to be
WRITTEN, not imported — that is not a harvest gap and no script will close it.
RESIDUAL, RESOLVED 2026-09-02: the two-writers-one-file clobber is closed.
`scripts/lib/notice.ts` (new) composes the root `NOTICE` from named,
delimited sections — `harvest-skills.ts` owns `SKILLS`, `harvest-personas.ts`
owns `PERSONAS` — and `writeNoticeSection(name, body)` rewrites only its own
section, leaving the other's markers and body exactly as they stood (empty,
never an error, if that script has never run on this machine). Section order
in the OUTPUT is fixed (SKILLS then PERSONAS) regardless of which script ran
or ran last, which is what makes the two writers commute.
Proved two ways. (1) The real scripts, for real: `harvest-personas.ts` ran
clean against both its actual clones (`indranilbanerjee/digital-marketing-pro`
@ fa4ccd0a, `Citedy/adclaw` @ 25bf9601) with a zero-byte diff on
`lib/agent/harvested-personas.ts`, in both run orders relative to a
SKILLS-section write, producing a byte-identical `NOTICE` either way, and
idempotent on a second run. **`harvest-skills.ts` itself could NOT be run
end-to-end** — 14 of its 16 upstream sources (kai-cmo-harness,
marketing-os-starter, geo-seo-claude, UGC-Factory, advertising-ops,
goviralbro, linkedin-automator, re-walkthrough-pro, claude-skill-social-post,
x-article-publisher-skill, coldoutboundskills, apify-mcp-server, graphify,
and adclaw/digital-marketing-pro under its OWN flat `<root>/<dir>` layout,
distinct from harvest-personas.ts's `<root>/<owner>/<repo>` layout) are not
cloned in this environment, and the script is fatal on the first missing
clone by design (`clone missing at ... — clone all four sources before
harvesting`) — so its own write was exercised through `writeNoticeSection`
directly with the real, previously-recorded skill counts/commits reconstructed
from the prior committed `NOTICE`, not fabricated. The committed `NOTICE` now
carries both real credit sets. (2) The mechanism, in CI:
`tests/notice-compose.test.ts` drives `writeNoticeSection` against a scratch
file and pins order-independence, idempotency, and that changing one section
never touches the other — revert-checked (all 6 red without the fix).

Original entry follows.

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

## 6. Text deliverables still on local disk, not storage — 2026-08-31

`createFile` (`lib/capabilities/deliverables.ts`) now has TWO storage paths,
by design, not by oversight: the three binary formats it gained this packet
(xlsx/docx/pdf) go through `lib/storage.ts` (`DELIVERABLE_BUCKET`, a private
Supabase bucket, signed URLs) because writing binary bytes to the old path
with an implicit utf8 encoding corrupts them outright. The five original text
formats (md/csv/json/txt/html) were left exactly as they were — writing to
`join(process.cwd(), 'public', 'generated', 'files')` — because moving them
was out of scope for this packet and the deploy target was (and still is)
unconfirmed; `infra/cloudflare` exists in this repo, and whether that target's
filesystem survives a redeploy is unknown.

That split is a real inconsistency: five of eight `createFile` formats live on
a filesystem whose durability nobody has verified, while the other three are
durable and private. It should not persist once the deploy target is known.

**Done when:** either (a) the deploy target is confirmed to have a durable,
persistent filesystem across redeploys, and that fact is written down here or
in a comment at the write site — no further code change needed — or (b) the
five text formats are moved onto `DELIVERABLE_BUCKET` the same way xlsx/docx/pdf
are, and `tests/deliverable-formats.test.ts`'s text-format-pinning block is
updated to assert a signed storage URL instead of a `/generated/files/` path.

---

## 7. Tick cadence was mis-measured — CORRECTED 2026-09-02

Not a risk; a correction, recorded because the wrong figure was repeated
several times and written into merged code before anyone re-checked it.

**The claim:** `/api/hermes/tick` runs about every 35 minutes, so a 95-item
batch step at 8 items/tick takes roughly 7 hours, and tick frequency is the
binding constraint on all long-running work.

**The truth:** it runs every **5 minutes**. A 95-item batch takes about **one
hour**.

**How the error was made.** The average was computed over `app_logs` for the
whole of August. The scheduler did not exist for most of that window — §2
records `pg_cron` job `hermes-tick-every-5-min` as only stood up 2026-08-28 —
so a mostly-unscheduled month was averaged and the result reported as current
behaviour.

```
app_logs, route ilike '%hermes%', all of August   n=1754  mean gap 26.0 min
app_logs, same filter, created_at >= 2026-08-28   n=1527  mean gap  5.0 min
cron.job id 1 'hermes-tick-every-5-min'           */5 * * * *, active
net._http_response                                72 rows, all 200, ~4.9 min apart
```

**What it changes.** `PLAN_ITEMS_PER_TICK` is a real lever, not a rounding
error: 8 items/tick clears 95 in ~1 hour, 16 in ~30 minutes. And the scheduler
is NOT outside the repo's reach — it is `cron.job` id 1 in this project's own
Postgres, editable with the same Supabase access used to apply migrations.

**Two traps for whoever measures this next.**
1. `cron.job_run_details.status = 'succeeded'` means pg_net QUEUED the
   request, not that it returned 200. Check `net._http_response.status_code`
   or `app_logs.status`. (Also in §2 — it caught someone twice now.)
2. Bound the window to the period the thing being measured actually existed.
   A real query over the wrong range is still the wrong answer, and it is more
   convincing than a guess because it comes with a number attached.

**Done when:** nothing to do. Left as a record because the corrected figure
now lives in `lib/plans/runner.ts`'s `ITEMS_PER_STEP_TICK` comment, and the
next person to tune batch throughput should find the reasoning rather than
re-derive it from a stale average.

## 8. Plaintext OAuth tokens still live in production `meta` until the backfill runs — 2026-09-02

`claude/encrypt-oauth-tokens` closed the code-level exposure (writers now
encrypt into `secret_encrypted`; every reader lazily migrates a row it
touches — see `lib/social/connection-token.ts`), but the branch has not been
deployed and the backfill has not been run. As of the exposure being verified
(2026-09-02), production still has these rows with a live token sitting in
plaintext `meta`:

```
instagram  2 rows
facebook   2 rows
notion     1 row
```

These stay plaintext until either (a) the connection is read through a
migrated code path in production, or (b) `scripts/encrypt-connection-tokens.ts`
is run. The script could not be run from this session — `AI_VAULT_KEY` lives
on the deployed service, not this container.

**Done when:** deploy the branch, then run (from an environment holding
`AI_VAULT_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`):

```
npx tsx scripts/encrypt-connection-tokens.ts --dry-run   # inspect first
npx tsx scripts/encrypt-connection-tokens.ts             # then apply
```

and confirm via `information_schema`/a direct query that the 5 rows above (and
any new ones since) have `secret_encrypted IS NOT NULL` and no `access_token`/
`refresh_token`/`user_token` key left in `meta`. Until that query is run
against production, "the fix shipped" is not the same claim as "the exposure
is closed" — the five known-plaintext rows are still sitting there.

## 9. Campaign asset image analysis is refused, not fixed — 2026-09-02

`POST /api/campaigns/[id]/assets/analyze` used to put an image URL into a TEXT
prompt and write the model's invented `score` / `issues` / `recommendation`
onto the asset row, flipping `status` to `approved` or `rejected`. A text model
never opened the image; the verdicts were fabricated and they mutated real
state. The route now returns **501 `not_supported`** and writes nothing
(`tests/campaign-asset-analyze-route.test.ts` pins both halves).

It is refused because there is **no image-input path anywhere in this
codebase**: `ChatMessage` in `lib/ai/opencode.ts` is `{ role, content: string }`,
`generateChat` in `lib/ai/router.ts` takes those messages with no image parts,
and nothing constructs one. The "Analyze assets" button in
`app/campaigns/page.tsx` therefore can now only ever report the refusal.

**Done when:** either (a) a vision-capable model is configured and a real
image-input path exists — proven by a test that asserts an image part actually
reaches the provider payload, not that a call returned 200 — and the route is
reimplemented on top of it; or (b) the button and the route are removed
outright. Leaving a button whose only outcome is a refusal is the
written-but-never-read pattern in UI form.

## 10. Migration 082 — APPLIED AND VERIFIED 2026-09-02

`migrations/082_model_list_prices.sql` corrects
`anthropic/claude-sonnet-5`'s `cost_per_mtok_in` from 3.00 to the published
2.00 (Anthropic cancelled the September 1 increase to $3/$15; the catalogue
was written 2026-08-29, three days before it would have taken effect). It has
been applied to production (project `kqimpzbphdogvchqmtos`) on 2026-09-02.

**CLOSED.** Verified the way this entry required — by querying the table, not
by trusting the apply call's `success: true`:

```
label                    model_id                     in        out       enabled
Claude Haiku 4.5 (paid)  anthropic/claude-haiku-4.5   1.000000  5.000000  true
Claude Sonnet 5 (paid)   anthropic/claude-sonnet-5    2.000000  10.000000 true
```

`cost_per_mtok_out` is unchanged, so `isPaidModel` (lib/ai/providers.ts:359,
`cost_per_mtok_out > 0`) still returns true for that row and `orderByCost`
produces the same chain order it did before. That was the actual risk in this
migration and it did not fire.

## 11. `AI_PROMPT_CACHE_MARKERS` is off and has never been exercised live — 2026-09-02

`lib/ai/prompt-cache-markers.ts` adds an Anthropic-style `cache_control`
breakpoint to the first system message on `anthropic/*` OpenRouter models,
behind `AI_PROMPT_CACHE_MARKERS` (default OFF). The marked request shape was
never sent to the real API: openrouter.ai is unreachable from the environment
it was written in, so every test is against a stubbed `fetch`. The default is
off for exactly that reason.

The saving it targets is measured and large: the tool catalogue alone is
41,542 chars (~10,386 tokens), byte-identical across all ~16 steps of a turn,
~27% of an average 38,878-token call.

**Done when:** the flag has been set to `1` on the running service and
OpenRouter's own dashboard shows non-zero cache reads on an `anthropic/*`
model — the provider's counter, not our log line saying we sent the field. If
the counter stays at zero, the marker is not landing and the flag should go
back off rather than be left on as decoration. Watch `app_logs` for
`retrying once without it` while it is on: that warning firing means the
gateway is rejecting the field and every marked call is costing a round trip.

## 12. `internal_write` and `read` capabilities still have no digest — 2026-09-03

The digest guard (`tests/capability-digest-guard.test.ts`) now requires a
`digest` on all four SENSITIVE gates. It requires nothing on the other two.

Measured against the live registry on 2026-09-03 (183 capabilities total):

```
external_send:   9 caps,  0 without digest   ← guarded
spend:           3 caps,  0 without digest   ← guarded
destructive:     6 caps,  0 without digest   ← guarded 2026-09-03
standing_rule:   7 caps,  0 without digest   ← guarded 2026-09-03
internal_write: 62 caps, 45 without digest   ← OPEN
read:           96 caps, 26 without digest   ← OPEN
```

**Why this is a risk and not just untidiness.** Without a digest,
`successObservation` (lib/agent/loop.ts) puts the raw JSON in the transcript
alone and the model states the outcome itself. That is the exact mechanism
behind the defect this whole packet exists for — "the last batch already went
out to all 13 contacts" when one email had been sent two weeks earlier. The
gate class bounds how bad a false claim is, not whether one can happen: an
`internal_write` that silently matched no row still gets narrated as a
success, and 45 of them can.

**A known sub-case, found while writing the destructive digests.**
`deleteContentItem` and `deletePillar` (lib/content/store.ts) run
`.delete().eq(...)` with **no `.select()` and no row-count check**, then return
`{ id, deleted: true }` where `id` is the argument they were handed. A delete
matching zero rows returns byte-for-byte the same object as one removing a
row, so there is no evidence at the capability layer to digest. Their digests
say so explicitly rather than claiming a removal. Adding `.select('id')` to
both store functions would make the row count real and let those two lines
state a fact instead of a hedge. Same shape as the house anti-pattern: the
return value is written and never actually read for what it claims to prove.

**Done when:** `GUARDED_GATES` in `tests/capability-digest-guard.test.ts`
contains `internal_write` and `read`, that file passes, and the per-gate
count above reads 0 without digest for both — verified by enumerating
`CAPABILITIES` at runtime, not by reading this file. The two store functions
above return a real row count, proven by a test that deletes a
non-existent id and asserts the capability's digest stays silent.
