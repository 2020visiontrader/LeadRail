# LeadRail — full-flow QA audit

Target: `feat/copilot-remediation` (48 commits ahead of `main`; `main` is what production serves).
Status: IN PROGRESS — authenticated as owner (aifranckie101@gmail.com, role=owner)
via the live Chrome session. Testing target: PRODUCTION (`main`).

---

## Confirmed defects

### D1 — Production `/welcome` is a DIFFERENT, older page than this branch (HIGH)
Production does not serve the landing page in this branch at all. Two different
pages share the URL:

| | This branch (`feat/copilot-remediation`) | Production (`main`) |
|---|---|---|
| H1 | "An AI that runs your marketing — and asks before it spends" | "Find, enrich and close leads before anyone else calls them." |
| CTAs | "Book a demo" / "See an example run" | "Start free" / "Get Started" / "Create your workspace" |
| Signup claim | "Access is arranged directly — there is no self-serve signup" | implies free self-serve signup |

The branch's page header comment sets an explicit rule: CTAs must say "Book a
demo" or "Request access", and *never* "Start free". Production violates that
rule on every CTA. Merging the branch replaces the page and resolves D2 with it.

### D2 — Landing page CTAs are a dead end / false promise (HIGH)
On production `/welcome`, **"Get Started"**, **"Start free"** and **"Create your
workspace"** all point to `/login`. `/login` states: *"Invite-only operator
console — there's no public signup. Locked out? Ask your workspace admin to
reset your access."*

A stranger who clicks "Start free" is promised self-serve onboarding and lands
on a form they cannot get through. There is no signup route in the codebase.
Every acquisition CTA on the site terminates in a wall.

### D3 — The authenticated app shell renders on the public landing page (HIGH)
`AppShell` wraps `/welcome` in production, so the page carries BOTH the
marketing header (Features / How it works / Ventures / Log in / Get Started)
AND the logged-in nav rail (Dashboard, Assistant, Leads, Enrichment, …), with a
second `<main>` nested inside the first. Confirmed in the server-rendered HTML:
a `fetch('/welcome')` response body contains all 22 nav links.

Two distinct symptoms from one cause:
- **Logged out:** `NotificationsBell` (mounted inside `AppShell`) calls
  `/api/notifications` → `401` → the `lib/api.ts` wrapper hard-redirects to
  `/login?next=%2Fwelcome&expired=1`, telling a first-time visitor their
  session expired. The public page is unreachable.
- **Logged in:** no 401, so no redirect — instead the visitor sees the landing
  page nested inside the app chrome, two headers stacked. (Observed directly by
  the platform owner during this audit.)

**Root cause:** `bareRoutes` at `src/components/AppShell.tsx:94` on `main` is
`['/login','/privacy','/terms','/data-deletion']` — `/welcome` is missing.

**Fix status:** ALREADY FIXED on this branch (`AppShell.tsx:98` adds
`/welcome`). Verified locally: `/welcome` renders clean, no rail, stays put.
**Unmerged.**

**Not fixed by the merge:** `lib/api.ts:14` attributes every 401 to an expired
session, so "never had a session" and "session expired" produce the same wrong
message. Worth splitting.

### D4 — Nav label/URL mismatch: "Pipeline" → `/deals`, "AI Pipeline" → `/pipeline` (MEDIUM)
In the rail, the item labelled **"Pipeline"** links to `/deals`, while the item
labelled **"AI Pipeline"** links to `/pipeline`. The URL that reads as the
pipeline page is not the one the Pipeline nav item goes to. Confusing to
navigate, bad for shared links and analytics, and a trap for anyone reasoning
about routes from the nav.

### D5 — Admin is an inline rail item, not a separate portal (MEDIUM, design)
`/admin` and `/logs` are appended to the same left rail as every product page
(via `OWNER_NAV`, gated on `role === 'owner'`). The gating itself is correct —
`/api/auth/me` returns `role`, non-owners get an "owners only" notice, and
client accounts never see the links. But the stated goal of "admin portal
separate from the platform" is not met visually or structurally: it is just two
more rows in the product nav. Confirmed the current session is
`role: "owner"`, which is why these are visible — not a leak.

---

## Environment notes
- No `.env.local` in the working tree, so `dbReady()` is
  false locally — local dev has no database and cannot authenticate.
- Chrome extension reports zero connected browsers, so the originally requested
  "Chrome live" session is not currently available.
- **Hermes needs no download.** It is already in-repo: `lib/ai/hermes.ts` (the
  agentic router / planner), `lib/hermes/agent.ts` (job processor),
  `lib/ai/nim.ts` (NVIDIA NIM, last-resort tier of the routing ladder), and the
  `/api/hermes/tick` cron entrypoint. NIM is reached only when Ask Zo and
  OpenCode Go both fail or are unconfigured.

---

## Backlog — recorded, not actioned

### B1 — Assistant should be a per-tab side panel, not a rail item
Raised by the platform owner during this audit. Today the Assistant is launched
from the left nav rail (`src/components/AppShell.tsx`, dock toggle + `⌘J`).
Desired: the Assistant is available *on every tab*, docked to its own side
panel rather than living in the rail, so it is contextually bound to whatever
section the user is currently in. Needs a design pass to decide which side,
how it coexists with the rail, and how per-tab context is passed to it.
Not scheduled.

---

## Still to test (all gated behind login)
Login flow · dashboard · leads · enrichment (Apollo, ≤5 credits) · campaigns ·
content creation · sequences · social pages · assistant thinking-steps &
delegation to Hermes · memory/knowledge · admin portal separation ·
backend-connection leakage to end users · every tab, component and clickable.

---

# Landing page information architecture

## D12 — Every landing-page "tab" is a scroll anchor, not a page (MEDIUM)
`app/welcome/` contains exactly two files — `page.tsx` and
`opengraph-image.tsx`. There are **no sub-pages**. The entire marketing site is
one route, and every nav item is an in-page anchor:

| Version | Nav items | Target |
|---|---|---|
| Production (`main`) | Features, How it works, Ventures | `#features`, `#how`, `#ventures` |
| This branch | How it works, Capabilities, Architecture, FAQ | `#how-it-works`, `#capabilities`, `#architecture`, `#faq` |

Clicking any of them scrolls down the same page. None navigates anywhere. The
expected behaviour — each tab opening its own page — is not implemented in
either version.

Consequences: no per-topic URL to link or share, nothing separately indexable
for SEO/answer engines (which undercuts the GEO work the branch page documents
as its purpose), no per-page analytics, and the back button does not work as a
visitor expects after clicking a "tab".

**To build:** promote each section to a real route (e.g. `/welcome/how-it-works`,
`/welcome/capabilities`, `/welcome/architecture`, `/welcome/faq`), keep the
one-page version as an overview, and give each route its own metadata and
`opengraph-image`. This is additive and does not touch the app shell.

## Settings / profile / account audit — NOT YET DONE
`app/settings/page.tsx` is 522 lines and includes Google Drive, Notion and
Google Ads connections, plus account deletion (`DELETE`, "Could not schedule
deletion"). A full audit of what a new account gets initialised with — and what
is missing — is still outstanding; the browser bridge dropped mid-check.
Also still outstanding: `/enrichment` (⚠ 5-credit budget untouched so far),
`/campaigns`, `/content`, `/sequences`, social connections, and the admin
portal's tenancy boundary.

---

# Fixes applied (working tree, branch `feat/copilot-remediation`, NOT committed)

## F1 — D7: stop swallowing the agent's model-call error ✅
`lib/agent/loop.ts`. Both catch sites around `generateChat` now bind the error
and persist it via `log.error()` before emitting the user-facing message, with
`accountId`, `step`, `afterTool` and `messageCount`. `afterTool` is the field
that matters — it distinguishes a cold failure from the post-`List leads`
failure that D7 reproduces. Added a `lastToolName` tracker to both loops and the
`log` import. **`npx tsc --noEmit` passes.**

This does not fix the failure — it makes it diagnosable. It is a precondition
for fixing D7 properly, and for D8 it means SSE runs finally leave a record.

**Not visually verifiable right now:** it is a logging change with no UI surface,
and local dev has no `.env.local`/database, so the branch cannot be exercised
against real data on this machine. It will be observable in `/api/logs` once
this branch is deployed — the next failed run should produce an `error` row on
route `agent stream: model call failed`.

## D6 — already fixed on this branch, no action needed
The misleading label is `origin/main` only:
`origin/main:src/components/AgentConsole.tsx:337` sets
`doneLabel = "Worked through it · N steps"` unconditionally and auto-collapses
on completion, so a failed run reads as a success. **This branch removed the
collapsing wrapper entirely** and always renders steps expanded. Merging fixes
it. (Note: local `main` is stale and diverged from `origin/main`; compare
against `origin/main`.)

---

# Skills architecture — how skills are actually selected

## There are THREE separate mechanisms, and they do not compose
| Path | Selector | Behaviour |
|---|---|---|
| **Assistant** (`lib/agent/loop.ts:673,874`) | `loadEnabledSkillsForAgent(accountId)` | Injects **every enabled skill** for the account into the system prompt as a bullet list. **No selection, no ranking, no routing.** |
| **Generation** (`lib/ai/generation.ts:210`) | `selectSkillsForGoal(goal, venture.skills)` | Deterministic **keyword matching** against the goal string. |
| **Hermes** (`lib/ai/hermes.ts`) | AI planner → `{intent, skillIds[], model, taskKind}` | The real router — a cheap classify call picking 1–4 skills plus a model tier, with a keyword fallback. |

## D13 — Hermes is NOT in the assistant's path (HIGH, architecture)
The only importer of `@/lib/ai/hermes` in the entire codebase is
`app/api/hermes/route/route.ts`. `lib/agent/loop.ts` never calls it.

So the intended design — request → Hermes → skill selection + model routing →
delegation — **is not what runs when a user talks to the assistant**. The
assistant dumps all enabled skills into the prompt and lets the model sort it
out. Hermes is a well-built router sitting on a side endpoint, unused by the
product's main surface.

## D14 — `account_skills` is broken in production, so the assistant runs with ZERO skills (HIGH)
`/api/diagnostics` on production:
```
{"name":"table_counts","status":"error","detail":"failed: account_skills"}
counts: { ai_providers: 0, personas: 0, mcp_clients: 0,
          scheduled_tasks: 0, account_skills: null }
```
`/api/skills` returns a healthy 12-skill catalog, so the catalog is fine — it is
the **join table** that fails.

`loadEnabledSkillsForAgent` (`lib/skills/store.ts:206`) wraps its query in
`try { … } catch { return []; }`. A failing `account_skills` therefore yields an
empty skill list **silently** — no error, no warning, no user-visible signal.
The assistant is running today with no skills at all and nothing says so.

Two defects in one: the table is broken, **and** the failure is indistinguishable
from "no skills enabled". At minimum the catch should `log.warn` so this is
visible; ideally it should distinguish empty from failed.

Also note `ai_providers: 0` and `personas: 0` — the provider registry and
persona system are likewise empty in production.

---

# Memory architecture — there is no Graphify

## D15 — Graphify was specified but never built (MEDIUM, scope)
`MARKETING_OS_SEED_SPEC.md:73` lists **"Graphify — memory graph (BRAIN)"** as a
Wave 1 integration. It does not exist: no `graphify` reference anywhere in
`lib/`, `app/` or `migrations/`, and no graph dependency in `package.json`.

## What memory actually exists (and it is real)
| Layer | Implementation |
|---|---|
| Conversation persistence | `agent_conversations` (migration 022) — verified live: a prior chat survived reload |
| Explicit facts | `rememberFact` / `forgetFact` / `listFacts`, 500-char cap (`memory.ts:167`) |
| **Semantic recall** | `agent_memory_embeddings` (migration 036) — pgvector, `match_agent_memory` RPC, NVIDIA `nv-embedqa-e5-v5` (1024-dim), cosine ≥ 0.25 |
| Blended digest | `recallMemoryDigest` — semantic hits first, padded with recency, deduped, capped |
| Cross-chat handoff | `CarryoverMemo` + `ingestCarryoverFacts` — objective, decisions and open tasks carried into a fresh chat |

So cross-chat memory persistence **does** work, via a **flat vector store plus
explicit facts**, not a graph. The practical difference: it retrieves facts by
similarity but stores no relationships between them, so it cannot traverse
("which venture does this persona belong to, and what did we decide about it?")
— that is exactly what a graph layer would add.

**Recommendation:** treat Graphify as a genuine open scope item, not a bug. The
vector layer is sound and is the right substrate to build a graph on top of.
Do not start it until D7 and D14 are closed — an unskilled, silently-failing
assistant will not benefit from richer memory.

---

# Measured against the product vision

Vision (owner, 2026-08-18): *anyone plugs in any brand — an idea, a brand already
built, an established company, any venture — and the assistant understands what
they're doing, asks the right questions to gather context, and takes it from
there, automated with a human in the loop.*

Four pillars. Only one is actually built.

| Pillar | State | Evidence |
|---|---|---|
| **1. Universal intake — any brand, any maturity** | Partial | A 3-step **static form** wizard exists (`app/page.tsx:257` — name/description → targeting → deck & focus), with deck profiling (`/api/ventures/[id]/deck`, `/profile`). It takes what you type; it does not adapt to whether you are at idea stage or established. |
| **2. The assistant asks the right questions** | **Missing** | Intake is a form, not a conversation. The assistant has no `createVenture` capability and never participates in onboarding. Asked to create a venture it correctly replies *"I don't have a tool to create new ventures directly"* and sends you to settings — the opposite of the vision. |
| **3. Agency-grade expertise per task** | **Broken in production** | `dbCatalog: 0` — migration `025_skills.sql` is not applied to production. `/api/skills` returns 12 skills only because they are **static constants** in `lib/skills/registry.ts`; the DB-backed catalog is empty and `account_skills` errors. Compounding it, Hermes — the router that would pick the right expertise per task — is **not wired into the assistant** (D13). |
| **4. Automation with a human in the loop** | **Built, and built well** | Six gate types; `spend`/`destructive`/`external_send`/`standing_rule` all route through a persisted approvals row with a single-use `approvalId` and an args hash, so a resubmitted-but-rejected proposal cannot execute (`loop.ts:880`, `lib/approvals/store.ts`). This is the strongest part of the system. |

## D16 — WITHDRAWN (was: "migration 025 not applied"). See D16-REVISED below.
Confirmed live: `/api/skills` → `{ builtinSkills: 12, dbCatalog: 0 }` and
`/api/diagnostics` → `account_skills: null`, `table_counts: error`.

The 12 skills visible in the UI are hardcoded constants, not database rows. Both
`skills` and `account_skills` (migration `025_skills.sql`) are absent from the
production database, so:
- no skill can be enabled for an account,
- `loadEnabledSkillsForAgent` silently returns `[]` (`store.ts:206` swallows it),
- **the assistant runs with zero skills and reports nothing.**

`ai_providers: 0`, `personas: 0`, `mcp_clients: 0`, `scheduled_tasks: 0` in the
same payload suggest this is not isolated to 025 — several later migrations look
unapplied. **Audit which migrations have actually run against production before
fixing anything else.** This is the highest-leverage item in the audit: it is a
deployment gap, not a code defect, and it is silently disabling whole subsystems.

## What this reorders
Ranked by "does this stop a new brand being plugged in and run well?":

1. **D16** — migrations unapplied; the expertise layer does not exist in prod
2. **D2** — every landing CTA promises "Start free"; there is no signup route at all, so no new user can ever plug a brand in
3. **D13** — Hermes unwired; even with skills present, nothing routes them per task
4. **D7** — the assistant dies after any data-returning tool (now at least loggable)
5. **D9 gaps** — no `createVenture`, no brand kit, no content domain
6. **D15** — Graphify absent; "understands how you operate" has no relationship layer

D1/D3/D6 (landing page, run labels) are already fixed on this branch and land
with a merge. The approval system needs no work.

## F2 — D12: landing-page tabs are now real pages ✅ (verified with screenshots)

**Before** — clicking "How it works":
`url: /welcome#how-it-works` · `scrollY: 1331` · `title: "LeadRail — the AI marketing CRM…"` (unchanged) · same document

**After** — clicking "How it works":
`url: /welcome/how-it-works` · `scrollY: 0` · `title: "How it works — LeadRail"` · own page, nav item marked `aria-current="page"`

All six routes verified 200 with distinct titles and correct canonicals:

| Route | Title | Canonical | App-shell rail present |
|---|---|---|---|
| `/welcome` | LeadRail — the AI marketing CRM… | `/welcome` | no |
| `/welcome/example-run` | Example run — LeadRail | `/welcome/example-run` | no |
| `/welcome/how-it-works` | How it works — LeadRail | `/welcome/how-it-works` | no |
| `/welcome/architecture` | Architecture — LeadRail | `/welcome/architecture` | no |
| `/welcome/capabilities` | Capabilities — LeadRail | `/welcome/capabilities` | no |
| `/welcome/faq` | FAQ — LeadRail | `/welcome/faq` | no |

### What changed
- `src/components/welcome/content.ts` — entity constants, `FAQ`, `CAPABILITY_DOMAINS`, `DEMO_MAILTO` extracted so one copy feeds every page.
- `src/components/welcome/sections.tsx` — each section as a component. Fragment-wrapped: how-it-works is two `<section>`s and the grouping had to survive without adding a wrapper element that would change layout.
- `src/components/welcome/Shell.tsx` — shared header/nav/footer, `WELCOME_NAV` as the single nav source, `active` for `aria-current`.
- `app/welcome/page.tsx` — 556 → 135 lines; renders the same sections in the same order, so the overview is unchanged (confirmed by screenshot).
- `app/welcome/{example-run,how-it-works,architecture,capabilities,faq}/page.tsx` — five routes, each with its own title/description/canonical/OG.
- `src/components/AppShell.tsx` — **`bareRoutes` now matches on a path-segment boundary, not exact equality.** Without this every new sub-page would have been wrapped in the authenticated shell — D3 again, one segment deeper. Verified: `railLinks: 0` on all six.

`npx tsc --noEmit` passes.

### Deliberately not changed
`DEMO_MAILTO` still points at a personal Gmail address (see D17). Fixing the
tab structure and changing the primary conversion path are separate decisions.

## D17 — The primary CTA is a mailto to a personal Gmail (MEDIUM)
Every "Book a demo" on the marketing site is
`mailto:aifranckie101@gmail.com?subject=LeadRail — demo request`. It opens the
visitor's mail client, captures no lead, records nothing in the CRM, and shows a
personal address as the company contact — on a platform whose own product is
lead capture. `/api/public/forms/[id]/submit` already exists and is built for
exactly this. Routing the CTA through a LeadRail form would dogfood the product
and capture the lead.

---

# CORRECTION — D14/D16 were wrong. Verified directly against the production DB.

Project confirmed as LeadRail production before any query: account
`00000000-0000-0000-0000-0000000000b1` present, owner `aifranckie101@gmail.com`,
2 account rows — all matching `/api/auth/me` and `/api/diagnostics`. Only one
project exists on the Supabase org. **All queries read-only; no writes made.**

## What is actually true
```
skills                    0 rows   (table EXISTS)
account_skills            0 rows   (table EXISTS)
ai_providers              0 rows
personas                  0 rows
accounts                  2 rows
agent_memory_embeddings   DOES NOT EXIST
```

**Migration 025 IS applied.** The skills tables exist. D16's claim that it was
never applied is withdrawn.

## D16-REVISED — the skills catalog was never seeded (HIGH)
`skills` has **0 rows**. The tables are correct and empty. So
`loadEnabledSkillsForAgent` legitimately returns `[]` — there is nothing to
enable. The assistant genuinely runs with no skills, but the cause is a missing
**seed**, not a missing migration and not a broken table.

The 12 skills visible in the UI come from `SKILLS` in
`lib/skills/registry.ts` (static constants). They have never been written to the
database, so no account can enable any of them.

## D14-REVISED — the "broken table" was a diagnostics bug ✅ FIXED
`app/api/diagnostics/route.ts` counted rows with
`.select('id', { count: 'exact', head: true })`. `account_skills` is keyed on
`(account_id, skill_id)` and **has no `id` column** — columns are
`account_id, skill_id, enabled, overridden_instructions, created_at`. The probe
therefore errored on that table and reported `failed: account_skills`, which
read as "the skills subsystem is broken" when the table was fine.

Fixed: count with `'*'` instead of `'id'`. With `head: true` + `count: 'exact'`
no rows transfer either way, so it costs nothing and works on any table shape.
`npx tsc --noEmit` passes.

## D18 — WITHDRAWN. Migration 036 IS fully applied (see correction below).
The table does not exist in production. So `semanticRecall`
(`lib/agent/memory.ts:285`) calls `match_agent_memory`, the RPC fails, and the
`catch { return []; }` swallows it. **Semantic memory recall is silently dead in
production** — `recallMemoryDigest` degrades to recency-only.

This is the layer behind "understands how the user operates". It is not that
Graphify is missing on top of a working vector store — the vector store itself
is not deployed.

## Note on the migration ledger
Supabase's `supabase_migrations` ledger lists only 5 entries (all 2026-08-17),
while `migrations/` holds 49 files. Most were applied outside the ledger, so
**the ledger cannot be trusted to tell you what is deployed.** Schema state must
be checked table by table, as above. That is itself worth fixing — it is why
this went unnoticed.

---

# SECOND CORRECTION + production fixes applied

## D18 withdrawn — 036 is fully applied
I checked for a *table* named `agent_memory_embeddings` (the migration's
filename). The migration does not create a table — it adds a column to
`agent_memory`. All four objects are present in production:

```
vector extension              installed
agent_memory.embedding        vector(1024) present
idx_agent_memory_embedding    HNSW index present
match_agent_memory()          function present
```

`agent_memory` has 0 rows, so recall returns nothing — but that is an empty
store, not a broken one. **Root cause of my error: inferring database object
names from migration filenames instead of querying the schema.** The same
mistake produced D16. Both are withdrawn.

## Full schema audit — the database is healthy
**86 tables** in `public`, covering every subsystem (accounts, contacts, deals,
sequences, campaigns, social, skills, personas, approvals, referrals, webhooks,
memory, logs). No missing tables found. The migrations ARE applied.

Caveat that caused all this: Supabase's `supabase_migrations` ledger lists only
**5** entries while `migrations/` holds **47** files. Most were applied outside
the ledger, so **the ledger cannot tell you what is deployed** — schema state
must be queried directly. Worth fixing so the next audit is trustworthy.

## F3 — D16-REVISED: global skill catalog seeded ✅ (verified live)
`skills` was empty. Seeded all 12 built-ins from `lib/skills/registry.ts` as
global rows (`account_id IS NULL`, `source='builtin'`), mapping
`when → description` and `systemModule → instructions`. Idempotent via
`ON CONFLICT (slug) WHERE account_id IS NULL DO UPDATE`.

**Verified through the live app, not just the DB:** `/api/skills` `catalog`
went **0 → 12**.

## F4 — skills enabled for the owner account ✅
`account_skills` had 0 rows, so even with a catalog the assistant would still
have loaded nothing. Enabled all 12 for `00000000-…-b1`: **12 rows, all
`enabled = true`**. `loadEnabledSkillsForAgent` now returns 12 instructions
instead of `[]`.

Scoped to the owner account **only** — the second account is a separate tenant
and its skill selection is its own decision.

### Caveat this exposes
With D13 unfixed, the assistant injects **all 12** enabled skills into every
system prompt regardless of task — no selection, no ranking. That is better than
zero, but it is not what Hermes was built to do. Wiring Hermes into the loop
(D13) is what turns 12 always-on instructions into the right 1–4 per request.

## Note: `/api/diagnostics` still reports `failed: account_skills`
Expected. The fix (count with `'*'` not `'id'`) is in the working tree on
`feat/copilot-remediation`; production runs `origin/main`. It clears on deploy.

## Database changes made (both additive, both idempotent, no deletions)
| Migration | Effect |
|---|---|
| `seed_global_skill_catalog` | INSERT 12 global rows into `skills` |
| `enable_builtin_skills_for_owner_account` | INSERT 12 rows into `account_skills` for account …b1 |

No schema was altered, no rows deleted, no other account touched.

## F5 — Landing page: warm beige palette, scoped ✅ (verified with screenshots)

**Before:** the marketing pages inherited the console theme — navy canvas, teal
primary, blue links. The landing page looked like the dashboard.

**After:** a `.marketing` scope in `app/globals.css` re-binds the SAME token
names to a warm palette, so every existing class picks it up with no markup
change and **zero effect on the authenticated app**:

| Token | Light | Dark |
|---|---|---|
| `--bg-canvas` | `#F4EFE4` warm paper | `#171310` |
| `--bg-surface` | `#FBF7EF` | `#201B16` |
| `--text-primary` | `#2B2418` warm near-black | `#F2EBDF` |
| `--ink` (primary CTA) | `#3E3527` espresso | `#D9C29A` sand |
| `--brand` (links) | `#9A6B34` ochre | `#C9A87C` |

No blue, no red, no teal — those read as product status colours and were part of
why the page felt like a tool.

Verified live at `/welcome` and `/welcome/capabilities`, both modes:
`marketingScoped: true`, `appRail: false`, CTA contrast `rgb(62,53,39)` on
`rgb(251,247,239)`.

**Caught by screenshotting, not by reading the code:** the first light-mode
capture showed the "Book a demo" CTA with apparently invisible text. Computed
styles were correct — it was a repaint artifact from toggling the theme class
without a reload, and it cleared on refresh. Worth recording because the
symptom (an unreadable primary CTA) is indistinguishable from a real contrast
bug until you check the computed values.

Also fixed: `<body>` sits behind the `min-h-screen` marketing div and still
carried the console's slate canvas, visible as a blue-grey flash on overscroll.
`html:has(.marketing) body` now paints it warm in both modes.

## D3 status — the rail on the logged-out landing page
Already fixed on this branch and extended to the new sub-pages (`bareRoutes`
now matches on a path-segment boundary). Verified `appRail: false` on all six
marketing routes. **What was seen in production is `origin/main`, which does not
have the fix.** It resolves on deploy.

## D19 — The landing page is flat (OPEN, design)
Owner's assessment: reads like a PDF — static text stacked vertically. Making
each tab a real route (F2) fixed the URL structure but not this; it produced
five flat pages instead of one.

Reference behaviour wanted: a contained explorer where the content pane scrolls
**within itself** while the page stays put, so a visitor moves through services
without scrolling down and back up.

**The pattern already exists in this codebase.** `ArchitectureTabs`
(`src/components/welcome/ArchitectureTabs.tsx`) drives seven panels
(`panel-assistant`, `panel-approval`, `panel-registry`, `panel-models`,
`panel-memory`, `panel-integrations`, `panel-interfaces`). It is used once;
everything else is flat prose. Extending it to Capabilities and How-it-works
with internal scroll reuses proven code rather than inventing a new interaction.

Blocked on one decision: **depth** (explore capabilities in place, no long
scroll) vs **motion** (page feels alive as you scroll). They pull in different
directions.
