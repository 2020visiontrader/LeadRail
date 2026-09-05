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

## 6. ~~Text deliverables still on local disk, not storage~~ — RESOLVED 2026-09-04

`createFile` (`lib/capabilities/deliverables.ts`) had TWO storage paths: the
three binary formats (xlsx/docx/pdf) went through `lib/storage.ts`
(`DELIVERABLE_BUCKET`), the five text formats (md/csv/json/txt/html) still
wrote to `join(process.cwd(), 'public', 'generated', 'files')`, deferred
because the deploy target was unconfirmed.

The deploy target is Zo, and Zo's filesystem does not survive a redeploy —
confirmed while auditing the four `public/generated/` write sites (2026-09-04,
same packet as the `character_refs.storage_path` fix below). All eight
`createFile` formats now build `bytes` first, then share one write through
`DELIVERABLE_BUCKET` (`ensurePrivateBucket` / `putPrivate` / `signUrl`) — see
the "BINARY SOURCE" / "TEXT SOURCE" split in `lib/capabilities/deliverables.ts`.
The old comment claiming "the uuid segment is what makes the URL unguessable"
was security-by-obscurity on a public path and has been replaced.

**Done when:** `tests/deliverable-formats.test.ts` asserts every one of the
eight formats returns a signed `DELIVERABLE_BUCKET` URL and none write under
`public/generated`. Done — see `tests/generated-storage-migration.test.ts`
and the updated pinning in `tests/deliverable-formats.test.ts`.

---

## 21. `campaign_assets.url` and `content_items.media_url` still accept a
persisted signed URL — 2026-09-04

Closing the `public/generated/` defect (four write sites moved onto
`lib/storage.ts`'s new `GENERATED_BUCKET`, plus `character_refs.storage_path`
added in migration 086) established the invariant "a stored asset is
identified by its path; a signed URL is minted at read time and never
persisted." Two more columns violated it:

- `campaign_assets.url` — **RESOLVED 2026-09-04.** Migration
  `087_campaign_asset_storage_path.sql` added `campaign_assets.storage_path`
  (nullable — `importAsset`/`POST /api/campaigns/[id]/assets` still attach a
  genuinely external URL with no storage object behind it, same mixed case
  `character_refs.image_url`/`storage_path` already solved). Both writers
  (`lib/capabilities/workspace.ts`'s `generateImage` and the same-shaped
  `app/api/generate/image/route.ts` handler — a second live instance of the
  same defect the original plan for this item didn't name) now persist
  `storagePath` alongside `url`. `resolveCampaignAssetUrl`/
  `resolveCampaignAssetUrls` (`lib/crm.ts`) re-sign from `storage_path` at
  READ time, mirroring `resolveCharacterRefUrl`, and every reader of
  `campaign_assets.url` is routed through them: the `listAssets` capability
  (`lib/capabilities/campaigns.ts`), `GET /api/campaigns/[id]/assets`, and —
  the one that actually fetches the bytes — `launchCampaign`
  (`lib/campaigns/actions.ts`), which used `asset.url` directly to upload the
  creative to Meta and would otherwise have failed a launch on any asset
  older than 24h. Applied to production (project `kqimpzbphdogvchqmtos`);
  `information_schema.columns` confirms `storage_path text`, nullable, with
  the column comment, and `pg_class.relrowsecurity` confirms RLS stayed on.
  Row count was 0 both before and after. Covered by
  `tests/campaign-asset-storage-path.test.ts` (revert-checked: reverting
  either the write-site fix or the resolver's `if (asset.storage_path)`
  branch reproduces the predicted test failure).
- `content_items.media_url` (`migrations/050_content_engine.sql`) — **still
  open, still latent, confirmed unreachable as of 2026-09-04.** Neither
  `createContentItem`'s capability schema (`lib/capabilities/content.ts`) nor
  `generateContentPiece`'s save path passes `mediaUrl`, and no HTTP route
  writes `content_items` directly (`grep` for `createContentItem` /
  `content_items` under `app/` returns nothing) — the column and the trap
  both exist, but nothing generates a value for it today, so leave it open
  rather than build a resolver for a column with no live writer.

**Done when** (`content_items.media_url` only, `campaign_assets` above is
closed): the column gets a matching `storage_path` sibling ahead of, or in
the same change as, whichever future capability first wires content
generation to `media_url` — not after.

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

## 12. Migration 083 — APPLIED AND VERIFIED 2026-09-03

`migrations/083_agent_conversation_stop_request.sql` adds
`agent_conversations.stop_requested_at`, the column the cooperative
server-side stop reads between steps. Applied to production (project
`kqimpzbphdogvchqmtos`) on 2026-09-03.

**CLOSED.** Verified against `information_schema`, not the apply call's
`success: true`:

```
column_name        data_type                   nullable  has_comment
running_since      timestamp with time zone    YES       true
stop_requested_at  timestamp with time zone    YES       true
```

Shape matches `running_since` (migration 072) exactly, which is the pattern
it was modelled on. The reader's own predicate was then run against the live
table: 30 conversations, 0 with `stop_requested_at` set — a clean baseline,
and proof the column is queryable rather than merely present.

**Named reader, per the rule about columns nothing reads:**
`isStopRequested` in `lib/agent/memory.ts`, called between steps in BOTH
`runAgentImpl` and `runAgentStreamImpl` (`lib/agent/loop.ts`). Disabling only
the streaming check fails 2 tests, so the loop real chat turns actually run
is covered on its own rather than riding on the JSON twin.

**Still unproven in production:** no real user has clicked Stop against this
yet. The column has never been non-null. Done when a production turn is
stopped and `app_logs` carries `agent stream: stop requested, ending turn
early` with the turn ending in salvage rather than running to completion.

**Two defects found in review, fixed 2026-09-03 (branch
`claude/leadrail-assistant-audit-8ki6ws`):**

1. The stop was only ever checked at the TOP of a step, before the model
   call — but the common turn shape is one model call returning
   `action:'final'` followed immediately by a ~40s `composeAnswer` call and a
   return, with no second iteration to re-check. A stop clicked seconds into
   that turn was never observed. Fixed by checking again immediately before
   `composeAnswer`, and immediately after every tool execution completes
   (which also closes the case where the loop falls straight from its last
   tool call into the forced-final call with no further check at all) — one
   shared `stopRequested`/`stopResult`/`emitStopFinal` helper set in
   `lib/agent/loop.ts`, used at every call site in both loops so they cannot
   drift from each other.
2. `clearStopRequest` ran unconditionally at the START of every turn, which
   raced the exact workflow the feature exists to support: click Stop, then
   immediately send the corrected message — the NEW turn's route cleared
   `stop_requested_at` out from under the OLD turn still running server-side,
   so the old turn's next check saw nothing and ran to completion.
   `isStopRequested` now requires `stop_requested_at > running_since`, which
   makes a stale stop from a prior turn harmless without an unconditional
   clear at turn start. `clearStopRequest` is no longer called there; it now
   runs only at turn END, alongside `clearConversationRunning`.

**Known remaining limits, not fixed here:**

- A stop that arrives WHILE a model call is in flight still waits for that
  call to return — nothing threads an `AbortSignal` into the fetch. Closing
  that needs `AbortSignal` plumbed from the route through
  `generateChat`/`streamChat` (`lib/ai/router.ts` and below), a separate
  piece of work.
- `stop_requested_at` and `running_since` are both APPLICATION-clock ISO
  strings (`new Date().toISOString()`, written by the Next.js process), not
  Postgres timestamps — the comparison above relies on the stop being
  written later in wall-clock terms, not on a database-enforced ordering. If
  the instance serving `POST /api/agent/stop` has a clock behind the
  instance that stamped `running_since` by more than the gap between turn
  start and the click, the stop reads as stale and is silently ignored. In
  practice this is unlikely — a user clicks Stop seconds into a turn, and
  NTP-synced instances typically differ by milliseconds — but it is a real,
  narrow failure mode, not "no skew to reason about". Closing it for real
  means moving one or both timestamps onto Postgres' own clock (e.g. a
  `now()` column default); that is a separate decision from the fix above,
  not attempted here.

## 13. The background layer has still never executed — 2026-09-03

Four tables remain at zero rows in production: `agent_plans`,
`agent_plan_steps`, `scheduled_tasks`, `agent_memory`. Commit 2ed611a fixed
the three defects that made plans structurally unrunnable — an approval that
re-proposed instead of executing, steps that ran with no grounding, and a
plan-mode draft that could never leave `draft` because `approvePlan` had zero
callers. That makes the layer *able* to run. It is not evidence that it *has*.

**CROSSCHECKED 2026-09-03, and the runner was not the binding constraint.**
The layer below is healthy; the queue above it is empty. Measured against
production:

```
cron.job 1 'hermes-tick-every-5-min'  */5 * * * *  active
net._http_response                    72 rows, ALL 200, latest 07:30 today
app_logs POST /api/hermes/tick -> 200 861 calls in 3 days
runPlanTick                           wired, called by the tick every run
PLAN_CAPABILITIES                     registered in the catalog
```

So the runner has fired ~861 times in three days against an empty table.
`agent_plans` is 0 because NOTHING EVER CREATED A PLAN, not because a plan
failed to run. Across all 274 logged turns (2026-08-25 to 2026-09-02):

```
createPlan called                     0
any plan tool called                  1  (getPlan, 2026-08-29, returned null)
outcome 'escalated'                   0
turns recording planOnly              0
```

**All three entry points to createPlan are dead:**

1. *The model choosing it.* The ONLY prompt text instructing createPlan sits
   inside `planOnly ? ... : ''` (lib/agent/loop.ts ~line 477), so it exists
   only when plan mode is toggled on. In an ordinary turn nothing tells the
   model to plan — createPlan is discoverable only as one line inside the
   183-tool, 48k-char catalog. 0 calls in 274 turns is the result.
2. *Plan mode.* Never recorded in production.
3. *Deadline escalation* (shipped 2026-09-02, converts a timed-out turn into
   a plan). `outcome='escalated'` is 0; 31 turns ended in error and 8 in
   salvage without ever escalating.

Commit 2ed611a fixed three defects that would each have broken the FIRST plan
to run — an approval that re-proposed instead of executing, steps with no
grounding, a draft that could never start. Those were real and necessary.
They do not make a plan exist, and this entry previously implied the only
missing thing was running one. That was wrong.

**Done when:** one real plan runs end to end in production and this entry
carries its `agent_plans.id` and the ids of its completed
`agent_plan_steps` — row ids, not a passing test and not `success: true`.
That now requires fixing the entry point first, not just the runner.
Until then treat every "it runs in the background as a plan" claim in the
assistant's own copy as unverified.

Related and untouched: `agent_memory` at 0 rows while every one of the 30
conversations carries `memory_extracted_at`, so the extractor ran and wrote
nothing, and `recallMemoryDigest` still pays for an embedding call on every
turn to search an empty table.

## 14. Migration 084 — APPLIED AND VERIFIED 2026-09-03

`migrations/084_scheduled_tasks_claim.sql` adds `scheduled_tasks.run_state`
and `claimed_at`, the columns the scheduled-task claim reads. Applied to
production (project `kqimpzbphdogvchqmtos`) on 2026-09-03.

**CLOSED.** Verified against `information_schema` and `pg_indexes` /
`pg_constraint`, not the apply call's `success: true`:

```
column      data_type                  nullable  default
claimed_at  timestamp with time zone   YES       null
run_state   text                       NO        'idle'::text

idx_scheduled_tasks_single_claim   present
scheduled_tasks_run_state_check    present
```

**Named readers, per the rule about columns nothing reads:**
`claimScheduledTask` / `runDueScheduledTasks` in `lib/scheduled/store.ts`.
The defect it closes is real: `runDueScheduledTasks` is reachable from BOTH
`/api/hermes/tick` and `/api/scheduled-tasks/run-due` with no claim, so the
same due task could be run twice concurrently — and it runs up to 25 full
agent turns. Revert-checked: a claim that always succeeds fails three tests,
including a second concurrent claim returning true and a task running twice.

**One honest note on the index.** `idx_scheduled_tasks_single_claim` is
`UNIQUE ON scheduled_tasks(id) WHERE run_state = 'running'`. Because `id` is
already the primary key, that index enforces nothing a unique `id` did not
already enforce — it is not the analogue of `claimStep`'s partial index,
which is on `(plan_id)` and genuinely enforces one active step PER PLAN. The
actual protection here is the conditional UPDATE in `claimScheduledTask`,
which is what the revert-check exercises. The index is harmless and left in
place; it should not be cited as the guarantee.

**Still unproven in production:** `scheduled_tasks` has 0 rows, so no task
has ever been claimed. Done when a real task is claimed and released — the
same standard as #12 and #13.

## 15. Migration 085 — APPLIED AND VERIFIED 2026-09-03

`migrations/085_count_functions.sql` adds `count_leads_grouped`,
`count_deals_grouped` and `count_companies_grouped` — the GROUP BY that
PostgREST cannot portably express. Applied to production (project
`kqimpzbphdogvchqmtos`) on 2026-09-03.

**CLOSED.** Verified against `information_schema.routines`, not the apply
call's `success: true`:

```
count_companies_grouped  INVOKER
count_deals_grouped      INVOKER
count_leads_grouped      INVOKER
```

Then checked against reality rather than the function's own return value:
`count_leads_grouped(…, 'brand')` returned `retentionrail:56, filmops:5`,
summing to 61 — matching the real `contacts` row count. That also settles the
audit's anecdote about three delegates reporting 54, 56 and 61 leads: they
were all reading the same 61-row table and counting it differently in JS.

**Named readers, per the rule about things nothing reads:** `countLeads`,
`countDeals`, `countCompanies` in `lib/capabilities/{leads,deals,companies}.ts`,
registered in `CATALOG_ORDER` (`lib/capabilities/registry.ts`) by commit
`f4a3b0e`. Registration was the actual gap — the capabilities shipped in
`83760a0` fully built, tested and backed by these functions, and were
unreachable for an hour because nothing listed them. Twelfth instance of the
house anti-pattern, caught before merge rather than after.

**Still unproven in production:** no real turn has called a count tool yet.
Done when `ai_usage` (or `app_logs`) shows a production turn whose tool calls
include `countLeads`, and the answer it produced carries the same number this
entry records.

## 16. 353 skills enabled by a write nothing in the app can make — 2026-09-03

`account_skills` holds **353 rows, every one `enabled = true`, one account,
all created 2026-08-18 between 12:01:24 and 14:46:36**. Zero disabled rows.
The only writer in the application is `setAccountSkill`
(`lib/skills/store.ts:181`), a **single-row** upsert behind the per-skill
toggle; `POST /api/skills/sync` writes the global `skills` catalog
(`account_id IS NULL`) and never touches `account_skills`. So no UI path can
produce this shape — it came from outside the app.

The token half is **closed** by commit `f4a3b0e`: `skillsBlock`
(`lib/agent/loop.ts`) now caps injected skill text at 8,000 chars per turn and
2,000 per skill, clipped at a sentence boundary with a marker naming
`describeSkill` and the slug. Harvested skills average 11,269 chars and the
largest is 94,247, so four routed skills could previously be 45K chars. That
cap holds regardless of how many rows are enabled.

**Still open, and it is a DATA decision, not a code one:** routing quality.
Hermes shortlists 1–4 skills out of 353 rather than out of the 12 curated
ones, and the remediation notes still claim "0 are enabled, so the budget is
safe today", which is false and should be corrected wherever it appears.

**Done when:** the owner decides whether to keep the harvested set enabled. If
not, `update account_skills set enabled = false` for the 341 harvested slugs
(reversible), and this entry records the row count actually changed. Nobody
should run that silently — it changes how the live assistant routes.

## 17. ~~Duplicate attachment rows are created at upload~~ — FIXED IN CODE 2026-09-03

**Code fix landed the same day** (`lib/documents/attachments.ts`, `ingestAttachment`):
before uploading, an identical `ready` document on the same account (same
`chars`, same `bytes`, same sha256 of the extracted text, never a
`scope='library'` row) is reused — bound to the incoming conversation when it
was unbound, returned as-is when it already belongs to that conversation, or
re-rowed without a second storage object when it belongs to another one.
`deleteAttachment` removes the storage object only when no other row still
references its `storage_path`. Proven by `tests/attachment-ingest-dedupe.test.ts`
(9 tests, revert-checked). The production proof in **Done when** below still
stands: nothing has been uploaded since.

Original entry follows.

## 17 (original). Duplicate attachment rows are created at upload — 2026-09-03

One 34,456-char voice transcript is stored **nine times** (three unbound, two
copies each in two conversations). `POST /api/assistant/attachments`
(`app/api/assistant/attachments/route.ts`) calls `ingestAttachment` with no
content hash and no idempotency check, so every upload writes a new row even
when identical extracted text already exists on the account.

Commit `5637d15` dedupes by content hash **at render time**, so the model now
sees one copy — the context cost is closed. The rows are still being created.

**Done when:** the upload path refuses (or reuses) an attachment whose
extracted-text hash already exists for that account, and a production count of
`assistant_attachments` grouped by content hash shows no group with more than
one row for a newly uploaded file.

## 18. The context reductions are code-verified only — 2026-09-03

Commits `22ac3da`, `369bdbd`, `f722990`, `5637d15`, `83760a0`, `f4a3b0e` cut
what enters a model call: list rows projected to summary fields, observations
older than the last two reduced to their digest before the wire, budget
ceilings clamped so a 1M declared window cannot produce a 400K-char
observation cap, documents injected once then by handle, compose reduced to
draft plus the last two observations, and the tool catalog staged (48,268 →
3,812 chars).

Every one is proven by tests and a revert-check. **None is proven in
production.** The measured baseline was 55,318 avg input tokens per call on
the worst conversation, peaking at 148,872, against models with 128K–200K
windows.

**Done when:** `ai_usage` shows post-change turns and this entry records the
new avg and max `tokens_in` per call against those figures. Watch for the
opposite failure too — an answer that got worse because something it needed
was pruned. Specifically: a turn that calls `readDocument` because a stub was
not enough, or a compose answer missing a fact that used to come from
`agentContext`.

Note `ai_usage` cannot see most of this on its own: Zo Ask reported NULL
tokens on 299 of its calls, so roughly 60% of spend is unmeasured (gap C11,
unfixed). Until that is closed, any before/after comparison is over the
measured tiers only and should say so.

## 19. Four more audit gaps closed in code, none yet seen in production — 2026-09-03

Landed together on `claude/assistant-orchestration-gaps-qpv1jy` after the
context-audit branch was merged onto main:

- **Failed turns are persisted** (gap G8). `app/api/agent/stream/route.ts` and
  `app/api/agent/route.ts` now save an `error` outcome as a trailing assistant
  message carrying the exact text the user was shown, so a reload no longer
  shows an unanswered question and the next turn's model no longer reads its
  own failure as an open request. `tests/agent-error-turn-persisted.test.ts`.
- **Plans are visible** (gap G16). `lib/plans/runner.ts` marks the plan's
  conversation running around each step (so the console's existing poll
  repaints), appends a progress line for single-shot steps and for approval
  blocks, and raises one notification per status transition into
  done/blocked/failed. `listPlans` capability added (`lib/plans/store.ts`,
  `lib/capabilities/plans.ts`) so "what are you working on" has an answer.
  `tests/plan-runner.test.ts`, `tests/plan-list-capability.test.ts`.
- **Zo Ask tokens are estimated** (gap C11). `successUsage` in
  `lib/ai/router.ts` records `size.promptTokens` and an estimate of the reply
  as `usage_source='estimated'` whenever the provider reported nothing, so
  the usage panel shows the order of magnitude instead of NULL. Estimates
  stay split from reported totals in `getAiUsageSummary`.
  `tests/ai-router-estimated-usage.test.ts`.
- **Uploads deduplicated at ingest** (gap C5, §17 above).

**Done when, one line each, all from production:**
1. An `agent_conversations.transcript` whose last entry is an assistant
   message equal to a `turnFailureMessage` string, on a turn logged as
   `agent turn: error`.
2. An `agent_plans` row whose conversation shows `Step N done:` lines and a
   `notifications` row with `type='plan'` — which also closes §13.
3. `ai_usage` rows with `model_label='zoask'`, `ok=true`, `tokens_in NOT NULL`
   and `usage_source='estimated'`.
4. Per §17.

Still open from the audits, deliberately not started here: native tool use
and provider caching (G1), persisted candidate health (G4), page fetch for
research (G10), approvals decided from the Approvals page resuming the chat
(G19), calling (G20), harvested skills default (§16), and the two dead chat
UIs (sequences, inbox).

## 20. Production probe after the 4da2d5e deploy: the tick is not running the merged code — 2026-09-03

Deploy of `4da2d5e` was reported live at 13:5x UTC (`GIT_SHA=4da2d5e`,
new PID, "Ready"). To verify §13/§19 the memory watermarks on three
conversations were cleared at 13:57 and again on one conversation at 14:06.

What production did (all from `ai_usage`, `memory_edges`, `agent_memory`,
`app_logs`, not from any return value):

| tick | conversation | prompt tokens | outcome |
|---|---|---:|---|
| 14:00 | 3b08d196 (457K-char transcript) | 110,375 | 146 s on gpt-oss-120b; edges written; `agent_memory` unchanged |
| 14:00 | 28ac9366 (324K chars) | 79,239 | 47 s; edges written; unchanged |
| 14:00 | 2ad98991 (438K chars) | 101,542 | 65 s; edges written; unchanged |
| 14:10 | 28ac9366 again (probe) | 79,237 | identical prompt size; `agent_memory` still 0; edges 46 → 46 |

Two facts contradict the merged code: (1) `renderTranscript` at `4da2d5e`
caps the extraction prompt at `BUDGET.extractionChars` = 120,000 chars
(~30K tokens; verified by evaluating the module at HEAD), yet every prompt
was the WHOLE transcript at 4.1 chars/token; (2) `decideAndWrite` at
`4da2d5e` calls `recordFact` on every 'written' edge, yet 23 edges were
written and 0 facts. Both match the pre-#22 code exactly. A direct
`INSERT INTO agent_memory` with the same columns succeeds (probed inside a
rolled-back transaction), so the table is not the problem.

**Conclusion: the process answering `/api/hermes/tick` is executing
lib/memory/extract.ts and lib/ai/context-budget.ts from before PR #22/#23**,
whatever `GIT_SHA` says. Most likely a stale `.next` server bundle or a
second instance. Not fixable from the repo.

**Done when:** a tick after a confirmed rebuild produces an `ai_usage` row
for an extraction call with `tokens_in` under ~40,000 on one of these
conversations, and `agent_memory` count > 0. Clear one watermark
(`update agent_conversations set memory_extracted_at = null where id =
'28ac9366-65e5-42eb-94f2-108ad0acbf8f'`), wait one tick, read both.

Side finding from the same logs: OpenRouter credit is nearly gone. The
"affordable" ceilings in the 402 bodies fell from 13,801 to 11,219 tokens
(haiku) and 62,735 to 50,996 (luna) in ten minutes; only gpt-oss-120b still
serves. The four extraction calls above cost about 370K input tokens on it.
Top up or expect the OpenRouter tier to go dark.
