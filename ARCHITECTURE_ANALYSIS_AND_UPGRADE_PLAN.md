# LeadCRM — Architecture Analysis & Upgrade Plan

**Scope:** Analyze the architecture (data tables, input processing, backend design/code) of **Twenty CRM**, **OpenOutreach** (Python flagship + Go clone), **Apollo**, and **GoHighLevel (GHL)**, then map concrete upgrades onto our existing **Next.js + Supabase** app (`marketing-agency-os`). **This is a plan only — no code changes.**

**Clone status:** `twenty/` = real clone of `twentyhq/twenty` (reference only, zero shared code). OpenOutreach was NOT previously cloned; pulled two for this analysis into the conversation scratch (`ref/openoutreach-eracle`, `ref/openoutreach-go`). Our app shares no code with any of them.

---

## 0. Our current baseline (what we're upgrading)

**Stack:** Next.js App Router + Supabase (Postgres, service-role key) + REST route handlers. Multi-tenant by `account_id` (enforced app-layer after the recent security pass). ~40 tables.

**Data model already present:** `accounts`, `account_members`, `brands` (ventures), `contacts`, `companies`, `contact_company_roles`, `contact_aliases`, `contact_merges`, `deals`, `pipeline_stages`, `deal_contact_roles`, `activities`, `notes`, `sequences` → `sequence_steps` → `sequence_enrollments`, `message_templates`, `email_accounts`, `inbox_messages`, `email_campaigns`, `contact_events`, `campaigns`(ad) + `campaign_assets` + `campaign_members`, `content_calendar`, `territories`, `partners`, `cases`, `knowledge_articles`, `entitlements`, `integration_connections`, `apollo_searches`, `audit_log`, `hermes_jobs`, `hermes_sequences`, `social_engagement`.

**How we process outreach today (`lib/sequences.ts` + `lib/hermes/agent.ts` + `POST /api/hermes/tick`):**
- `sequence_enrollments` is the durable queue. Each row = (sequence, contact, current_step, status, next_run_at).
- `enrollContacts` inserts rows at step 0 with `next_run_at = now + step0.delay`.
- `processDueEnrollments(limit=25)` (the cron tick) selects `status='active' AND next_run_at <= now`, sends the current step via `sendOutreachEmail`, then either advances (`current_step+1`, `next_run_at = now + nextStep.delay`) or marks `completed`. Errors → `paused`.
- Follow-ups are scheduled **after** each send (offset model) — this is correct and matches OpenOutreach-Go.

**Baseline gaps (confirmed in code) that the reference platforms address:**
1. **No reply-based auto-stop** — the tick never checks whether the contact replied before sending the next step. `status='replied'` exists in the enum but nothing sets it during the send loop.
2. **No open/click tracking** — `email_campaigns.opened_at` exists but sequence sends don't emit tracked events.
3. **No suppression/blocklist** — no unsubscribe/bounce suppression table; only a `contacts.status` string filter in the newsletter path.
4. **No concurrency lock** — select-then-update isn't atomic; overlapping ticks can double-send (no `FOR UPDATE SKIP LOCKED`, no idempotency key).
5. **No deliverability controls** — no per-mailbox daily send caps, warmup, or jitter.
6. **Flat step types** — steps are email-only; no task/manual/wait-until/branch step types, no A/B variants.

---

## 1. Apollo — architecture (via live key + API design)

**Auth/setup:** REST, `X-Api-Key` header, base `https://api.apollo.io/api/v1`. Our key is **valid but free-tier** (emails returned obfuscated/locked — a hard plan limit, not an integration bug). We currently wrap only 2 endpoints: `mixed_people/api_search` (ICP discovery) and `people/match` (single enrichment).

**Core data objects (Apollo's model):**
- **People** (discovery pool) vs **Contacts** (records *saved into your* CRM) — a deliberate split: search is credit-metered discovery; saving is a separate CRUD step.
- **Organizations / Accounts** — company records; People link to an Organization.
- **Sequences (Emailer Campaigns)** → **Sequence Steps** (typed: auto-email, manual-email, action/task, LinkedIn) with **A/B variants** per step and per-step wait offsets.
- **Email accounts (mailboxes)**, **Lists**, **Saved Searches**, **Tasks**, **Deals**.

**Input processing pattern worth stealing:**
- **A rich, saved ICP filter DSL** — search bodies are structured filters (`person_titles[]`, `organization_num_employees_ranges[]`, `person_locations[]`, `q_keywords`, seniorities, technologies) + pagination. Apollo lets you *save* a search and re-run it. We log `apollo_searches` for audit but don't store reusable ICP definitions.
- **Discovery → save → enroll** as three explicit stages (we collapse search+import).
- **Typed sequence steps + A/B variants** (directly informs baseline-gap #6).
- **Bulk enrichment** (one call for many people) vs our per-contact loop.

**What to adopt (Apollo):**
- A saved **`icp_profiles`** table (reusable filter JSON) that feeds both Apollo search and future providers.
- **Bulk enrichment** endpoint use + **org enrichment** (we never enrich the company, only the person).
- Typed sequence steps + A/B variants (shared with Twenty/OpenOutreach synthesis below).
- *(Blocked)* email data usefulness requires a paid Apollo seat — note, don't engineer around it.

---

## 2. GoHighLevel (GHL) — architecture (via live token + API design)

**Auth/setup:** REST v2, base `https://services.leadconnectorhq.com`, `Authorization: Bearer <token>` + `Version: 2021-07-28`. Our token is a **location-scoped Private Integration Token (`pit-…`)** — agency endpoints (`/locations/search`) correctly return 403. **No `GHL_LOCATION_ID` is stored server-side** (client must pass it) — a real config gap. We wrap only the `social-media-posting/*` slice.

**Core data objects (GHL's model):**
- **Location** = sub-account = their hard multi-tenant boundary (per-location tokens). Analogous to our `account_id`, but enforced at the token layer.
- **Contacts** with **tags** + **custom fields** + **custom values** (flexible schema without a full metadata engine).
- **Opportunities** + **Pipelines** + **Stages** (we already mirror this: `deals` + `pipeline_stages`).
- **Conversations** — a unified thread model across SMS/email/chat/social (we have `inbox_messages`, a narrower version).
- **Calendars / Appointments**, **Tasks / Notes**.
- **Workflows / Campaigns** — event-driven automation: **trigger → filters → actions**. This is GHL's sequencing/automation engine (broader than linear sequences).

**Input processing pattern worth stealing:**
- **Everything is `locationId`-scoped** at the API boundary — clean tenancy. Pragmatic version: keep `account_id` scoping (done) + store the GHL location id as a per-account integration setting.
- **Tags + custom fields (JSONB)** on contacts — flexible, queryable, no metadata engine. This is the pragmatic middle-ground between our fixed columns and Twenty's full metadata schema.
- **Unified Conversations** across channels — generalize `inbox_messages` into `conversations` (thread) + `conversation_messages` (per-channel entries).
- **Workflows (trigger/filter/action)** — a data-driven automation model that supersedes hardcoded `hermes` triggers.

**What to adopt (GHL):**
- `contacts.custom_fields JSONB` + a `tags` model (contact_tags) for flexible segmentation.
- Store GHL location id per account in `integration_connections.meta`.
- Longer-term: a **conversations** table and a **workflow/automation** table (trigger + steps) — evaluated against Twenty/OpenOutreach in the synthesis.

---

## 3. Twenty CRM — backend architecture

NestJS + GraphQL + TypeORM (Postgres) monorepo. Read for **data-model + platform patterns**, not code reuse (incompatible stack).

**Data model — 16 standard objects.** Notable shapes:
- **`person`**, **`company`**, **`opportunity`** (pipeline via `opportunity` + stage), plus **`note`**/**`task`** and **`attachment`**, **`workspaceMember`**, **`dashboard`**, **`call-recording`**, **`timelineActivity`**, **`blocklist`**, **`message-campaign`**/**`message-list`**/**`message-list-member`**.
- **Polymorphic join targets — `noteTarget` / `taskTarget`:** a note or task attaches to *any* record (person OR company OR opportunity) through a join row, instead of fixed FKs. This is the single most portable schema idea for us.
- **`timelineActivity`** = one unified, append-only activity/audit feed across all objects.
- **`blocklist`** = email suppression list (we have none).

**Metadata-driven schema (Twenty's defining trait):** objects and fields are rows in `objectMetadata`/`fieldMetadata`; per-workspace Postgres tables are generated from that metadata, so users add custom objects/fields at runtime. **Composite field types** (address, currency, emails, links, fullName, phones) decompose into multiple join columns. Tradeoff: infinitely flexible custom schema, but a heavy engine. **We should NOT adopt the engine** — the pragmatic substitute is a `custom_fields JSONB` column + a `tags` table.

**Request / input lifecycle (write path):** GraphQL resolver (auto-built per object) → `DataArgProcessorService` validates + transforms each field by its metadata (type validators, unaccent, phone/email normalization) → `WorkspaceScopedRepository` **auto-injects `workspaceId` into every WHERE** (entity-based `remove`/`softRemove` are deliberately removed so nothing can bypass the guard) → `WorkspaceEntityManager` checks **object- and field-level permissions** then persists and **emits a DB event**. Tenancy = **row-level `workspaceId`** carried in `AsyncLocalStorage` per request.

**Cross-cutting patterns worth stealing:**
- **Soft delete:** `deletedAt` timestamp on deletable entities; default queries auto-exclude; a **trash-cleanup cron** hard-purges old rows; restore = clear `deletedAt`.
- **Search:** Postgres **`tsvector`** column (GIN-indexed) per object, ranked with `ts_rank_cd`/`ts_rank`, ILIKE-unaccent fallback.
- **Webhooks:** entity events → BullMQ `CallWebhookJob` → **HMAC-SHA256 signed** POST with timestamp/nonce headers.
- **Queues:** BullMQ (Redis) with `@Processor/@Process`, cron via `addCron`.

**Top 5 takeaways for our Next.js+Supabase CRM:**
1. **Polymorphic `note_targets` / `task_targets`** join tables (attach notes/tasks/activities to any entity) instead of the fixed `contact_id`/`company_id`/`deal_id` columns we have.
2. **Unified `timeline_activities`** table — fold our `contact_events` into one append-only feed rendered on every record.
3. **Soft-delete via `deleted_at`** + a trash-cleanup cron (we currently hard-delete).
4. **`tsvector` full-text search** on `contacts`/`companies` (GIN index) — cheap, huge UX win.
5. **Signed outbound webhooks** driven by a DB-event emitter + a queue (lets customers subscribe to `contact.created`, etc.); `custom_fields JSONB` + `tags` as the pragmatic metadata substitute.

## 4. OpenOutreach (Python, eracle) — architecture + backend

Django daemon (no HTTP API): "describe your product + target market → AI discovers, qualifies locally, and runs agentic email." The **AI lead-qualification loop** is the standout.

**Data model:** `Campaign` (product docs, target, `clauses` M2M = ICP axes, `model_blob` = per-campaign trained model, synthetic `anchor_*` cold-start positives) · **`Lead`** (`profile_url` unique, **`embedding` 384-dim**, `profile_text`, nullable `email`, `discovered_by`) · **`Deal`** (campaign-scoped state machine: `state`, `outcome`, `next_follow_up_at`, `email_message_id` thread root, `profile_summary`/`chat_summary`) · **`ChatMessage`** (per-thread, dedup unique `(deal, external_id=Message-ID)`) · **`Mailbox`** (SMTP/IMAP, **`daily_limit` measured** from Sent folder) · **`Task`** (DB-backed queue: type, status, `scheduled_at`, JSON payload) · **discovery lattice** (`Clause`, `DiscoveryQuery`, `EmptyClauseSet` for anti-monotone pruning).

**Discovery + qualification (Bayesian explore/exploit):** a Gaussian-Process regressor over lead embeddings selects *which lead to label* and *which query to fetch*; **an LLM makes the actual qualify decision**, the GP only ranks candidates and **gates paid spend** via a single `min_gp_confidence` constant (read in exactly two places so they can't drift). Cold-start uses synthetic anchor positives; explore = label most-informative (BALD), exploit = pursue highest-probability. Training labels are **derived from pipeline outcomes already recorded** (qualified deal = +1, wrong-fit = 0, unreachable = skipped).

**Outreach engine:** a Deal is an enrollment as a **finite state machine** (`QUALIFIED → READY_TO_FIND_EMAIL → FINDING_EMAIL → READY_TO_EMAIL → EMAILED → COMPLETED/FAILED/NO_EMAIL_BETTERCONTACT`), not a linear step index. `next_follow_up_at` advanced in **business hours** (weekends don't tick). One LLM agent drives the whole thread (branches on first-touch vs reply); on inbound reply it **doesn't auto-unenroll** — it ingests/threads the reply and the agent decides `send | wait | complete(outcome)`. Follow-ups only run where `outcome == ''`. Deliverability: **measured per-box caps** (percentile of Sent history w/ growth), **pool-wide pacing** (min-interval + jitter across openers *and* follow-ups), and a `SendVerdict` table recording only failures (transient 4xx vs hard 5.7.x reputation → pause box for the day).

**Task architecture:** single-threaded daemon, DB-backed queue claimed by **opportunity-cost priority**; `reconcile` = the cron tick, **mints at most one slot per type per cycle** (queue stays ≤1 interval deep). Enrichment is a **two-leg async handshake** — submit parks the deal in `FINDING_EMAIL` (excluded from selection so it can't be double-charged), the poll job re-schedules itself with backoff, and the job handle lives on the **task row, not the deal** (survives restarts). Idempotency via `_has_pending`; crash recovery resets orphaned RUNNING→PENDING at reconcile.

**Top 5 takeaways for us:**
1. **`contacts.embedding` (pgvector) + `qualification_score`**, trained on enrollment outcomes we already store — rank/gate who enters a sequence; steal the explore/exploit selection for which contacts to hand a human/LLM reviewer.
2. **One shared `min_score` constant** gating both auto-enrollment and any *paid* step (enrichment, verified-email lookup).
3. **Two-leg async enrichment handshake** with the provider job handle on a **job row, not the contact** (the `FINDING_EMAIL` exclusion prevents double-charge; survives restarts).
4. **Business-hours `next_run_at`** + reply → *classifier/LLM decides* completion (structured outcomes: converted / not_interested / no_budget / has_solution / bad_timing) rather than a blind "reply → stop".
5. **Centralized paced send-slot creation** (one module mints slots), **measured per-mailbox caps**, and a **`send_verdicts` failure table** classifying SMTP status to pause a box on reputation signals.

## 5. OpenOutreach (Go, ahanikotb) — architecture + backend

Go + Gin + GORM, ~1,550 LOC, Gmail-only "Lemlist clone." Tiny but it nails the exact outreach mechanics our engine is missing. Read for the **cron sequencing + reply-removal + pixel/link tracking** patterns.

**Two-database split (the standout structural choice):** the app DB (`test.db`: `User`, `Campaign`, `EmailSequence`, `Email`, `Lead`, `StepStat`) is separate from the task/queue DB (`tasks.db`: `Task`, `ExecutedTask`, `TaskCampaign`). Durable work-queue state is deliberately isolated from domain data — the queue can be wiped/replayed without touching CRM records.

**Data model:**
- `Campaign` — embeds `Stats` (opens/replies/clicks/unsubs + computed rates) and `[]StepStat` (**per-step funnel**: sent/opened/replied/clicked/unsub + per-step rates). `FirstEmailOffset` = delay before step 0.
- `Email` — `Subject`, `Body`, `TimeOffset time.Duration` (wait before this step). Personalization is literal `[FNAME]/[LNAME]/[PLINE]` token replacement.
- `User` — embeds Gmail OAuth token, `UserSettings{EmailsPerDay, EmailTimeOffset}`, and `EmailSentBuffer{EmailsSentToday, UnLockDate, RateLimited}` (the daily-cap state machine).
- `Task` (queue) — `ExecutionTime`, `EmailNumber` (step index), `ThreadId`, embedded `Lead`. `ExecutedTask` (audit) — `ThreadId`, `MessageId`, `EmailNumber`, embedded `TaskStats{Opened, EmailOpens}`.

**Sequencing engine (`executionChron`):** runs every X sec, `SELECT * FROM tasks WHERE execution_time < now`, loops `executeTask`. Each execute: (1) rate-limit gate — if `RateLimited` and unlock date not passed, reschedule +24h; (2) personalize subject/body; (3) rewrite tracking (below); (4) send — first email fresh (captures `threadId`, applies Gmail label), follow-ups sent **into the same thread** via `In-Reply-To` + `References` headers (proper RFC 2822 threading → lands in one conversation, improves deliverability); (5) increment stats; (6) **schedule the next step only after this send succeeds** (`ExecutionTime = now + nextStep.TimeOffset`), keyed to the same `threadId`; (7) delete the current task. **This offset-scheduling model is identical to ours and to eracle — three independent implementations agree, confirming our core loop is correct.**

**Reply-removal (`statsChron`, the key trick):** runs on an offset after the send cron. For each active user it polls Gmail `after:LASTSYNCTIME to:<me>` on the `INBOX` label, matches each inbound `threadId` to the latest `ExecutedTask`, bumps reply stats, then **`DELETE FROM tasks WHERE thread_id = ?`** — because the next step is the *only* pending task and it's keyed to the thread, deleting it removes the lead from the flow. Reply-stop falls out of the offset-scheduling model for free; no per-step reply check needed inside the send loop.

**Open/click/unsubscribe tracking:**
- **Pixel:** `makePixel` injects `<img src=".../pixels/{user}/{campaign}/{step}/{taskid}.png">`; `pixelHandler` increments opens **once** (guarded by `ExecutedTask.Opened` flag → dedup), returns a 1×1 PNG with `no-store` headers.
- **Link:** `xurls` extracts every URL in the body, **skips** ones already inside `src="…"` or anchor text, wraps the rest in `.../links/{...}?url=<escaped>`; `handleLinkTracking` increments clicks then 307-redirects to the decoded original.
- **Unsubscribe:** an unsubscribe link is appended to every send; `unsubscribeHandler` increments the unsub counter.

**Deliverability:** per-user `EmailsPerDay` daily cap; on hit, sets `RateLimited=true` + `UnLockDate=now+24h` and pushes the next task +24h. Pacing at campaign start staggers step-0 tasks across leads by `EmailTimeOffset` (lead index × offset) so the whole list doesn't fire at once.

**Honest weaknesses (don't copy these):** single-process SQLite; `executionChron` `Find`s all due tasks and loops with **no claim/lock** — overlapping ticks can double-execute (same class as our gap #4); open-tracking is proxy-inflated; **unsubscribe is only counted, never enforced as suppression** (the reference itself has the compliance gap Twenty's `blocklist` closes); no business-hours logic (eracle has it).

**Top 5 takeaways for us:**
1. **Reply-stop via "cancel the pending next step"** — since we already schedule the follow-up only after a send (`sequence_enrollments.next_run_at`), a reply-detection pass just needs to set `status='replied'` and stop advancing. Cheapest fix for baseline-gap #1; no send-loop rewrite.
2. **A reply-scan pass** (statsChron equivalent) driven off `email_accounts` IMAP/Gmail, watermarked by a `last_reply_sync_at`, matching inbound threads to enrollments by a stored `thread_id`.
3. **Pixel + link-rewrite tracking** into an `email_events` table, with a dedup flag on first open (baseline-gap #2). Reuse `email_campaigns.opened_at` or generalize to a proper events table.
4. **Per-step funnel stats** (`StepStat`) on `sequence_steps` — sent/opened/replied/clicked so users see where the sequence leaks.
5. **RFC threading (`In-Reply-To`/`References`) + per-mailbox daily cap** on `email_accounts` — threading makes both deliverability and reply-matching work; the cap is baseline-gap #5's minimum viable form.

---

## 6. Synthesis — prioritized upgrade plan mapped to our schema

**Design stance:** adopt the *patterns*, reject the *heavy engines*. We do **not** build Twenty's metadata/schema-generation engine or eracle's Bayesian GP qualifier now — both are high-complexity for our stage. Their pragmatic substitutes (JSONB custom fields, an outcome-derived score) get 80% of the value at 10% of the cost. Everything below maps onto the existing `marketing-agency-os` schema from §0 and the send path in `lib/sequences.ts` + `lib/hermes/agent.ts` + `POST /api/hermes/tick`. **Plan only — no code in this pass.**

### 6.1 Pattern → source → our target (map)

| # | Pattern to adopt | Source(s) | Our target table / route | Closes |
|---|---|---|---|---|
| 1 | Suppression / blocklist, enforced in every send | Twenty `blocklist`, eracle, Go (gap) | new `suppressions` (account-scoped: email/domain, reason, source) checked in `sendOutreachEmail` + newsletter path | gap #3 |
| 2 | Reply-stop = cancel pending next step | Go `statsChron`, eracle | `sequence_enrollments.status='replied'`; store `thread_id`; add reply-scan pass | gap #1 |
| 3 | Atomic enrollment claim | Twenty scoped repo, eracle reconcile | `sequence_enrollments`: `FOR UPDATE SKIP LOCKED` (or `locked_until`+`claim_id`) + send idempotency key | gap #4 |
| 4 | Open/click tracking + per-step funnel | Go pixel/link, Go `StepStat` | new `email_events` + pixel/link-rewrite in send path; counters on `sequence_steps` | gap #2 |
| 5 | Per-mailbox daily cap + pacing/jitter | Go `EmailsPerDay`, eracle measured caps | `email_accounts.daily_cap` + `sent_today`/`unlock_at`; jitter in tick | gap #5 |
| 6 | Typed steps + A/B variants | Apollo, eracle FSM | `sequence_steps.type` (email/manual/task/wait/branch) + `sequence_step_variants` | gap #6 |
| 7 | Business-hours `next_run_at` | eracle | tick scheduler helper | gap #6 |
| 8 | Structured reply outcomes (classifier) | eracle | `sequence_enrollments.outcome` enum (converted/not_interested/no_budget/has_solution/bad_timing) | quality |
| 9 | Unified timeline feed | Twenty `timelineActivity` | fold `contact_events` → `timeline_activities` (append-only, any entity) | UX |
| 10 | Polymorphic note/task targets | Twenty `noteTarget`/`taskTarget` | `note_targets` / `task_targets` join tables | model |
| 11 | Flexible fields + tags | GHL custom fields, Twenty metadata | `contacts.custom_fields JSONB` + `tags`/`contact_tags` | model |
| 12 | Soft delete + trash cron | Twenty `deletedAt` | `deleted_at` on core tables + purge cron | safety |
| 13 | Full-text search | Twenty `tsvector` | GIN `tsvector` on `contacts`/`companies` | UX |
| 14 | Unified conversations | GHL Conversations | `conversations` + `conversation_messages` (generalize `inbox_messages`) | model |
| 15 | GHL location id per account | GHL config gap | `integration_connections.meta.locationId` | config |
| 16 | Saved ICP + bulk/org enrichment | Apollo | `icp_profiles` (filter JSON); org-enrich in import flow | data |
| 17 | Two-leg async enrichment handshake | eracle | job handle on a job row, not the contact; exclude in-flight from selection | robustness |
| 18 | Signed outbound webhooks | Twenty | DB-event emitter + queue → HMAC-signed POST | platform |
| 19 | Workflow (trigger/filter/action) | GHL Workflows | `automations` table superseding hardcoded hermes triggers | platform |
| 20 | Contact embedding + score gating *(optional)* | eracle | `contacts.embedding` pgvector + `qualification_score` + one `min_score` const | advanced |

### 6.2 Phased rollout

**Phase A — Outreach engine correctness & deliverability (do first).** Closes baseline gaps #1–#5. Highest value because the engine already runs but is subtly unsafe (double-send) and non-compliant (no suppression, no reply-stop). Items 1–5. Order within: **1 (suppression) → 3 (claim lock) → 2 (reply-stop) → 4 (tracking) → 5 (caps/pacing).** Suppression first because it's the compliance blocker and lowest-effort; the lock before reply-stop because reply-stop writes to the same rows the tick claims.

**Phase B — Data-model depth.** Twenty/GHL structural patterns that make the CRM feel mature. Items 9–13. `custom_fields JSONB` + `tags` (11) and the unified `timeline_activities` (9) are the two with the biggest UX-to-effort ratio; soft-delete (12) is a safety net worth adding before customers hold real data. FTS (13) and polymorphic targets (10) follow.

**Phase C — Typed sequencing & light intelligence.** Items 6, 7, 8, 16, 17. Typed steps + variants (6) unlock manual/task/wait/branch and A/B; business hours (7) and outcome classification (8) raise reply quality; saved ICP + bulk/org enrichment (16) and the async enrichment handshake (17) upgrade the top of funnel. Gated behind Phase A because they extend the same send loop.

**Phase D — Platform / integration.** Items 14, 15, 18, 19, and optionally 20. Unified conversations (14) and the GHL location-id fix (15) deepen integration; signed webhooks (18) + a data-driven `automations` engine (19) turn hardcoded hermes triggers into a product surface. The pgvector qualifier (20) is explicitly **optional/deferred** — only worth it once we have enough labeled enrollment outcomes to train on, and even then the LLM makes the call while the score only ranks/gates spend (eracle's discipline).

### 6.3 What NOT to build (scope guard)
- **Twenty's metadata engine** (runtime object/field generation) — use `custom_fields JSONB` + `tags` instead.
- **eracle's Gaussian-Process qualifier** now — defer to Phase D optional; start with outcome-derived scoring only if/when needed.
- **A second datastore** (Go's SQLite split) — we get queue isolation from a dedicated `sequence_enrollments` table + claim lock; no new DB.
- **Agency-level GHL sync** — our token is location-scoped; treat GHL as one connected location, not a multi-location hub.

### 6.4 Immediate next step (when we move from plan → build)
Start Phase A, item 1: add the account-scoped `suppressions` table and a single `isSuppressed(accountId, email)` check wired into `sendOutreachEmail` and the newsletter send path. It's the lowest-risk, highest-compliance-value change and it touches the fewest files. Everything else in Phase A builds on the same send path.

---

## 7. Phase A — SHIPPED (2026-07-30)

Executed items 1–5. Typecheck + production build pass. Not committed/deployed.

| # | Item | Status | Files |
|---|------|--------|-------|
| 1 | Suppression / blocklist enforced in every send | ✅ | `migrations/009` `suppressions`; `lib/suppressions.ts`; wired into `lib/outreach.ts` (`SuppressedError`), newsletter `resolveRecipients`, Brevo webhook auto-suppress on hard_bounce/spam/complaint |
| 3 | Atomic enrollment claim (no double-send) | ✅ | `claim_due_enrollments()` `FOR UPDATE SKIP LOCKED` + `claim_id`/`locked_until` cols; `processDueEnrollments` claims via RPC (falls back to select if 009 unapplied) |
| 2 | Reply-stop = cancel pending next step | ✅ | `thread_id`/`replied_at` cols; `stopRepliedEnrollments()` runs before claim, marks `status='replied'` from inbound `inbox_messages` |
| 4 | Open/click tracking + per-step funnel | ✅ | `email_events` table + `sent/open/click_count` on `sequence_steps`; `lib/tracking.ts` (HMAC token, pixel + link rewrite); public `GET /api/track/open/[token]`, `/api/track/click/[token]`; `increment_step_counter()` |
| 5 | Per-account daily cap + jitter | ✅ | `accounts.daily_send_cap`, `email_accounts.daily_cap/sent_today/unlock_at`; `account_sent_today()` RPC; cap check + ±12min jitter in `processDueEnrollments` |
| — | One-click unsubscribe (compliance) | ✅ | public `GET /api/unsubscribe/[token]` (signed) → suppression + status flip |
| — | Admin suppression management | ✅ | session-scoped `GET/POST/DELETE /api/suppressions` |

**Deploy step:** apply the migration — `bun run migrations/push.ts` (uses `DATABASE_URL` or `SUPABASE_ACCESS_TOKEN`+`SUPABASE_PROJECT_REF`). Set `APP_URL` (or `NEXT_PUBLIC_APP_URL`) so tracking pixels/links resolve; without it, tracking no-ops and sends still work. Middleware now treats `/api/track` + `/api/unsubscribe` as public.

**Next:** Phase B (custom_fields JSONB + tags, unified timeline_activities, soft-delete, FTS).

---

## 8. Phase B — SHIPPED (2026-07-30)

Executed items 9–13. Typecheck + production build pass. Migration `010_data_model_depth.sql` (idempotent, backfills existing data).

| # | Item | Status | Files |
|---|------|--------|-------|
| 11 | Flexible fields + tags | ✅ | `contacts/companies/deals.custom_fields JSONB`; `tags`+`contact_tags`; `lib/tags.ts`; `GET/POST/DELETE /api/tags`, `/api/contacts/[id]/tags`; `custom_fields` accepted in `validation.ts` |
| 9 | Unified timeline | ✅ | `timeline_activities` (backfilled from `contact_events`); `lib/timeline.ts` (`recordTimeline` on note/activity create; `getContactTimeline` merges timeline + `email_events`); `GET /api/contacts/[id]/timeline` |
| 12 | Soft delete + purge cron | ✅ | `deleted_at` on contacts/companies/deals; reads filter `deleted_at IS NULL`; deletes now soft; `purge_soft_deleted(30d)` runs each `hermes/tick` |
| 13 | Full-text search | ✅ | generated `search_tsv` + GIN on contacts/companies; `lib/search.ts` (`websearch` type); `GET /api/search?q=` |
| 10 | Polymorphic note/task targets | ✅ | `note_targets`/`task_targets` (backfilled); `syncTargets()` mirrors fixed FKs on create; existing columns still work |

**Deploy:** apply `bun run migrations/push.ts` (010 is in `apply_all.sql`). Generated tsvector columns build the FTS index automatically; backfills run inside the migration.

**Next:** Phase C — typed steps + A/B variants, business-hours scheduling, structured reply outcomes, saved ICP + org/bulk enrichment.

---

## 9. Phase C — SHIPPED (2026-07-30)

Executed items 6, 7, 8, 16, 17. Typecheck + production build pass. Migration `011_typed_sequencing.sql` (idempotent). Extends the Phase A send loop; no send-path behaviour changes for existing (plain email) sequences.

| # | Item | Status | Files |
|---|------|--------|-------|
| 6 | Typed steps + A/B variants | ✅ | `sequence_steps.type` (email/wait/manual/task/branch); `sequence_step_variants` (+ per-variant sent/open/click/reply counters, `increment_variant_counter()`); `email_events.variant_id`, `sequence_enrollments.last_variant_id`; engine in `lib/sequences.ts` handles each type — wait/branch advance without sending, manual pauses for a human task, task opens a task and flows on, email sends the step or a weight-selected variant |
| 7 | Business-hours scheduling | ✅ | `accounts.business_hours` + `sequences.business_hours` JSONB (seq overrides account); `lib/business-hours.ts` (`nextBusinessTime` shifts every `next_run_at` into the tz/day/hour window); applied at enroll + every advance |
| 8 | Structured reply outcomes | ✅ | `sequence_enrollments.outcome` (converted/not_interested/no_budget/has_solution/bad_timing/unknown); `lib/reply-classifier.ts` (rule-based, zero-LLM) runs inside `stopRepliedEnrollments`; also credits the sent variant a reply |
| 16 | Saved ICP + org/bulk enrichment | ✅ | `icp_profiles` table; `lib/icp.ts`; `GET/POST /api/icp`, `GET/PATCH/DELETE /api/icp/[id]`; Apollo `enrichOrganization` + `matchPeopleBulk`; org-enrich auto-queued on Apollo import; `POST /api/leads/enrich/bulk` |
| 17 | Async enrichment handshake | ✅ | `enrichment_jobs` table (+ unique live-job index = no double-spend, `claim_enrichment_jobs()`); `lib/enrichment-jobs.ts`; drained by `hermes/tick` alongside sequences; bounded retries (3) |

**Scope honesty:** step type `branch` is stored and treated as a no-op skip until the data-driven automations engine (Phase D #19) lands — no conditional branching yet. The reply classifier is deliberately rule-based; the enum + call site are shaped so an LLM pass can replace `classifyReply` without touching the engine.

**Deploy:** apply `bun run migrations/push.ts` (011 is in `apply_all.sql`). All new columns default to today's behaviour (type='email', business_hours=null → 24/7), so existing sequences are unaffected until configured.

**Next:** Phase D — unified conversations, GHL location-id fix, signed webhooks, data-driven automations engine (pgvector qualifier optional/deferred).
