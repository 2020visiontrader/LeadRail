# LeadCRM — Outreach Pipeline Audit (end-to-end)

Audited 2026-07-30 against live code in `marketing-agency-os`. This is a ground-truth
audit of the whole journey: **pull → categorize → enrich → sequence → generate →
send → reply → attach (images/pitchdecks)** — the UI, the conversation/LLM layer, and
the funnel. Every claim below cites the file it came from. Ordered by how much it
hurts you, not by pipeline order.

---

## 0. The five structural truths (read these first)

These aren't bugs — they're architecture-level gaps that make the pipeline look
finished while being disconnected underneath.

1. **The sequencing engine has no front door.** `app/sequences/page.tsx` empty-state
   says "enroll leads from the Leads page." `app/leads/page.tsx` has **no enroll
   control anywhere.** The API (`/api/sequences/[id]/enroll`, `/api/campaign-members`)
   exists; nothing in the UI calls it. The entire multi-step engine (Stage D) is
   unreachable by a user. This is the single biggest gap.

2. **Generation is disconnected from sending.** `generateOutreach` /
   `generateContentPost` / `generateImage` return text/pixels to the browser and are
   **never persisted, never attached to a contact, never fed to a send.** Grep confirms
   no caller consumes `generateOutreach` except the route that returns it. AI is a
   "give me a draft" toy, not part of the machine.

3. **The inbound-reply loop is orphaned.** Nothing in the codebase ever writes
   `inbox_messages.direction='inbound'` (zero inserts, grep-confirmed). So the Inbox is
   permanently empty, and everything downstream of it is **dead code**:
   `stopRepliedEnrollments`, `classifyReply`, reply outcomes, variant reply-counts, and
   every `email.replied` automation. You built a reply brain with no eyes.

4. **Two sequence engines run at once.** `lib/hermes/agent.ts` (`hermes_jobs` table)
   and `lib/sequences.ts` (`sequence_enrollments` table) both run inside
   `/api/hermes/tick`. Only the second has reply-stop and locking. If both ever hold a
   live sequence for the same contact → **double sends, and the legacy one keeps
   emailing after a reply.**

5. **Attachments never reach a message.** The only media-attach code path is
   `lib/social/ghl.ts` (`mediaUrls`), which outreach never calls. Generated images save
   to `public/generated/` (ephemeral on serverless — 404 after redeploy). There is **no
   pitchdeck concept anywhere** and no attachment UI on the compose screen. The thing
   you explicitly asked about — images/decks riding along with outreach — does not
   exist end to end.

---

## 1. Correctness & security bugs to fix now (small, high-impact)

| # | Severity | File / symbol | Bug | Effect |
|---|----------|---------------|-----|--------|
| 1 | **Critical** | `app/api/leads/export/route.ts` | No `requireSession`, no account scoping — filters by `brand_id` only | Anyone who guesses a `brandId` exports another tenant's full contact list (name/email/phone/linkedin). Cross-tenant data leak. |
| 2 | **Critical** | `app/api/unsubscribe/[token]/route.ts` | `GET` mutates state (adds suppression + flips status) | Email/AV link-prefetch auto-unsubscribes recipients with no click. Must be POST (RFC 8058) or a confirm page. |
| 3 | **High** | `app/enrichment/page.tsx` vs schema | UI treats `enrichment_status==='enriched'` as done; backend writes `'done'`/`'none'` | Enriched contacts always show "pending"; "Enrich all pending" re-enriches done contacts forever → **repeat Apollo credit burn.** |
| 4 | **High** | `src/components/ContactDrawer.tsx` L83-85 | "Engagement Timeline" is hardcoded fake text | Every contact shows the same fake "opened 2 days ago." Ships as if real. |
| 5 | **High** | `lib/tracking.ts` | Tracking token = unsubscribe token, no expiry/nonce | Any leaked open/click URL can unsubscribe the contact forever; dev secret fallback `dev-insecure-secret-change-me` makes staging tokens forgeable. |
| 6 | **High** | `lib/integrations/resend.ts` | Resend is the **primary** sender but has **no bounce/complaint webhook** | Bounces/spam on the main channel never suppress → you keep hitting dead/complaining addresses → domain reputation death. |
| 7 | **High** | `lib/sequences.ts` fallback path | If migration 009 RPC absent, tick `select` has no locking | Concurrent/overrun ticks **double-send.** The "no double-send" guarantee lives entirely in one un-applied migration. |
| 8 | **Med** | `lib/ai/generation.ts` `parseJson` | Greedy `\{[\s\S]*\}`, no `responseMimeType:'application/json'` | Model prose/fences break parse → raw model text (with ```json fences) shipped as the email body, empty subject. |
| 9 | **Med** | `lib/ai/humanizer.ts` | `out.replace(/_/g,' ')` on the whole body | Corrupts `utm_source`, snake_case, filenames, any URL param in copy. |
| 10 | **Med** | `lib/reply-classifier.ts` | `converted` checked before `not_interested`; no negation | "Not interested in a demo" → **converted.** "No thanks, we already use X" → has_solution (masks the rejection). |
| 11 | **Med** | `app/api/webhooks/brevo/route.ts` | Non-prod with no secret accepts unauthenticated; campaign updates not account-scoped | Forged webhook can flip any account's campaign to opened/bounced. |
| 12 | **Med** | `lib/sequences.ts` create | `is_active` defaults `false`; tick auto-completes enrollments on inactive sequences | Enroll into a fresh sequence and everyone silently completes with zero sends. |
| 13 | **Low** | `lib/ai/gemini.ts` | API key in `?key=` querystring | Leaks into logs/error surfaces. |

---

## 2. Stage-by-stage: what exists, what's missing, what you haven't thought of

### Stage 1 — Pull a lead (Apollo / CSV / manual)
**Works:** `app/leads/page.tsx` Apollo ICP form → `searchPeople` preview → checkbox
import; CSV import/export; manual add. Fully user-triggered (nothing auto-pulls).

**Gaps:**
- `searchPeople` hardcodes `page:1` (`lib/integrations/apollo.ts`) — you can never pull
  past the first 100 matches even though `total` says thousands exist. No pagination UI.
- Locked leads get synthetic `@locked.apollo` emails as the **dedupe key** → the same
  locked person re-pulled = a duplicate row. `external_id`/`linkedin_url` are stored but
  never used as dedupe keys. Intra-batch dupes uncaught in both import paths.
- `/api/leads` POST (manual add) has **no dedupe at all** — unlimited duplicate emails.
- Leads list search/filter is **client-side on the current 30 rows only** — searching
  "john" misses everyone not on the visible page. Reads like full search; isn't.
- No AbortController/timeout/429 handling on any Apollo call.

**Haven't thought of:**
- **Save the ICP.** `icp_profiles` + `/api/icp` exist but the sourcing form is
  ephemeral — users retype the ICP every session. Add "Save this ICP" + a dropdown of
  saved ICPs with last-run count. This is 80% built in the backend already.
- **Dedupe key should be `linkedin_url || external_id || email`**, not email — locked
  Apollo leads defeat email dedupe by design.
- **Credit-cost preview** before import ("importing 25 locked leads; enriching all costs
  ~N Apollo credits").
- **"Net-new only" filter** on search results (grey out people already in the DB).

### Stage 2 — Categorize / score / segment
**Works:** `scoreContact` (segment×0.4 + title×0.3 + engagement×0.3); `computeFitVerdict`
(good_fit/maybe/skip); tags tables; segment filter.

**Gaps:**
- **Two different scoring formulas** (`lib/scoring.ts` vs `lib/enrichment.ts`) with
  different weights → a lead's score *jumps* when enriched; the two numbers aren't
  comparable. No single source of truth.
- **Score effectively caps ~66/100**: `scoreContact`'s engagement term (weight 0.3) is
  always fed `0` (every caller passes 0). A perfect lead can't score above the mid-60s.
- Apollo import hardcodes `segment='other'` → every imported lead scores off the default
  bucket regardless of who they are; seniority (which Apollo returns) is ignored by the
  score.
- Title match is naive substring — "account manager" is unreachable (always resolves to
  bare "manager").
- Tags exist but **nothing consumes them** — no tag-based filtering, no tag-driven
  segmentation, no bulk tag UI.

**Haven't thought of:**
- **Feed real engagement into the score.** You have `email_events` (opens/clicks) — wire
  the count into the dead 0.3 term. Score should rise as a lead engages, so hot leads
  float to the top automatically.
- **Show score + fit as sortable columns** in the leads table (they're hidden today).
- **A single `scoreLead()` function** both paths call, so import-score and enrich-score
  are the same number.

### Stage 3 — Enrich
**Works:** sync single-contact `/api/leads/[id]/enrich`; async job queue
(`enrichment-jobs.ts`) + bulk endpoint; fit verdict recompute; company enrichment on
import.

**Gaps:**
- **Two enrichment paths with no coordination** — the sync route bypasses the job queue
  entirely, so the "no double-spend" unique-index guard doesn't protect it. Same contact
  can be enriched sync + async → double Apollo spend, last-writer-wins.
- The enrichment **UI uses the sync route in a browser `for`-loop** (`enrichPending`,
  slice(0,25)) — close the tab and it stops. The proper async bulk endpoint exists and
  is unused.
- `attempts` is never incremented in code (`enrichment-jobs.ts`) → a permanently
  unmatchable lead either retries forever or gives up instantly, depending on whether a
  DB trigger you can't see increments it.
- Bulk auto-select uses `neq(status,'done')` → re-enqueues `failed` contacts every run
  (repeat spend on people Apollo will never match).

**Haven't thought of:**
- **A "do not re-enrich" terminal state** for `failed`/`unmatchable` so you stop paying
  for the same misses.
- **Auto-enrich only good-fit-on-paper leads** (title/seniority pass) before spending
  credits — don't enrich the whole list blindly.
- **Waterfall enrichment** (Apollo → fallback provider) for the ~30-40% Apollo can't
  match, instead of one provider and a dead end.

### Stage 4 — Sequence (the cadence engine)
**Works (backend):** durable enrollment queue, business-hours windowing, jitter, A/B
variant tables (`sequence_step_variants`, `last_variant_id`), per-account daily cap,
branch/wait/manual/task step types, reply-stop, `claim_due_enrollments` locking.

**Gaps:**
- **No enroll UI** (see Truth #1) — the whole thing is unreachable.
- **No step editor after creation** — `updateSequence` only edits name/channel/active;
  steps are create-only. No way to fix a typo in step 3.
- **No pause/activate toggle in UI**; cards show active/paused but you can't change it.
- **Per-mailbox caps + warm-up are dead** — `email_accounts.daily_cap/sent_today/
  unlock_at` exist in SQL, are **never read.** No mailbox rotation, no warm-up ramp. For
  cold outreach at any volume this is the #1 deliverability miss.
- Daily cap window is **UTC-day**, business hours are **per-account tz** — mismatched;
  cap resets at the wrong local time.
- Cap counter is per-tick in-memory → concurrent ticks can jointly exceed the cap.
- Reply-stop scans an **unordered 200-row** slice — with >200 active enrollments, some
  replied contacts keep getting hit; doesn't exclude OOO/auto-replies before stopping.
- On any send error the enrollment is set `paused` **permanently** — nothing un-pauses
  it. Transient Resend 500 = dead enrollment.
- No cross-sequence frequency cap — a contact can be in N sequences, each emailing
  independently. No global "max 1 touch/day/contact."

**Haven't thought of:**
- **Enroll from everywhere**: multi-select on the leads table → "Add to sequence";
  auto-enroll rule ("new good_fit lead in venture X → sequence Y"); enroll on import.
- **A live enrollment view per sequence**: how many active / sent / opened / replied /
  completed, where each contact is (step 2 of 4), next-send time.
- **Global send policy** (per-contact frequency cap, per-domain cap, quiet days,
  holiday calendar) that every sequence respects.
- **Mailbox pool + warm-up** — the tables are already there; wire rotation and a daily
  ramp (20 → 40 → …). Without this, volume outreach burns the domain.

### Stage 5 — Generate the message (the LLM layer)
**Works:** Gemini `gemini-2.5-flash` behind `generateOutreach`; persona builder;
humanizer; white-label guard; sequence-draft generation; content-post generation.

**Gaps:**
- **Not wired to sending or sequences** (Truth #2). One-off compose can drop a draft into
  the body box; sequences/variants never call the AI.
- **No grounding / anti-hallucination** beyond a prose "no fabricated stats" line —
  `venture.pitch` claims are unverified; the model can invent case studies and numbers.
- **No spam/deliverability lint on generated copy** — no spam-word scan, subject-length,
  ALL-CAPS, link-count, or spammy-phrase check. The rule lives only inside the prompt.
- **No A/B variant generation** — `generateOutreach` returns exactly one subject/body;
  the variant *tables* exist but the AI never produces variants. Generation and A/B are
  disconnected.
- **No feedback / learning loop** — reply `outcome` is stored and never fed back into
  prompts. `prompt-improver.ts` is static templating despite the name (no LLM, nothing
  learns).
- `EmailPreview` component exists but is **orphaned** — compose has no live preview, no
  `{{name}}` token rendering, no "how it looks to the recipient."

**Haven't thought of (message intent + skills):**
- **Make intent explicit and first-class.** Today "goal" is a free-text box on compose
  and nothing else. Model it: `intent ∈ {book_call, reply_bait, share_asset, breakup,
  reengage, referral_ask}`, drive prompt + CTA + subject from it, and store it on the
  message so you can measure reply-rate *by intent*.
- **A per-message "why this message" rationale** the LLM returns alongside the draft
  (what angle, which personalization signal it used) — turns the black box into
  something a human can approve.
- **Grounded generation**: pass only verified facts (enriched title/company/industry,
  the venture's real case studies from a knowledge table) and instruct "use only these
  facts." You already have `knowledge_articles` — use it as the fact source.
- **Reply-drafting skill** for the inbox: classify inbound → draft a context-aware
  reply the human approves (needs the inbound loop fixed first).
- **A variant tournament**: generate 2-3 subject/body variants, let the sequence engine
  A/B them (tables already support it), auto-promote the winner by reply-rate.
- **Deliverability lint as a hard gate** before a draft can be queued (spam score,
  link count, missing unsubscribe, image-to-text ratio).
- **Segment/persona-conditioned prompts** — `segment` is passed and ignored; different
  copy for investor vs. operator vs. partner.

### Stage 6 — Send
**Works:** `sendOutreachEmail` (suppression check, tracking injection, Resend-or-Brevo),
open/click/unsubscribe token routes, per-account suppression.

**Gaps:**
- **No `List-Unsubscribe` header and no unsubscribe link is ever injected** — the
  unsubscribe route is unreachable from real emails. CAN-SPAM + Gmail/Yahoo bulk-sender
  requirement miss.
- Provider "fallback" is **env-static, not runtime** — if Resend fails mid-send it does
  not fall back to Brevo (`withFallback` exists, unused).
- `sendResendEmail` is called **without `accountId`** → per-account BYO Resend keys are
  dead; always uses the env key.
- Direct compose send (`/api/outreach/send`) **bypasses the daily cap** entirely (cap
  only lives in the sequence tick).
- Suppression read is **fail-open** — a DB hiccup lets suppressed/unsubscribed contacts
  get emailed.

**Haven't thought of:**
- **A pre-send preflight** every send passes through: suppression + cap + unsubscribe
  footer present + spam-lint + valid-from-domain. One gate, both compose and sequence.
- **Seed/inbox-placement checks** and per-mailbox reputation tracking.

### Stage 7 — Reply / conversation
**Works (on paper):** rule-based classifier, conversation mirror table, reply-stop,
reply-outcome automations.

**Gaps:** **All of it is dead** because no inbound ingestion exists (Truth #3). Inbox
never fills; classifier/outcomes/automations never fire; conversations are outbound-only;
Brevo webhooks carry only opens/clicks/bounces, not reply bodies. Automations fire on
**only** `email.replied` — open/click/bounce triggers are unwired even though the
telemetry arrives.

**Haven't thought of:**
- **Fix the eyes first**: add inbound ingestion (IMAP poll or provider inbound-parse
  webhook) that writes `inbox_messages.direction='inbound'`. That one piece lights up the
  entire reply brain you already built.
- **Then**: LLM reply-classification with a confidence score, `unknown` → human queue;
  auto-draft replies; auto-advance deals on positive intent.
- **Wire open/click/bounce automation triggers** (they're one `evaluateAutomations` call
  away in the tracking routes).

### Stage 8 — Images & pitchdecks with the message (what you explicitly asked about)
**Current reality:** `generateImage` (Nano Banana) writes a PNG to `public/generated/`
and *optionally* logs a `campaign_assets` row. `campaigns/[id]/assets` lets you **paste
an image URL** (no upload) tied to an **ad campaign**, and "Analyze with AI" sends the
**URL as text** to Gemini (no vision — the score is hallucinated from a filename).

**What's missing for "assets ride along with outreach" — the whole funnel:**
- **No attachment UI on compose or on a sequence step.** No way to say "attach this
  image / this pitchdeck to this email."
- **No pitchdeck object at all** — no upload, no storage, no per-venture deck library.
- **No durable storage** — `public/generated/` vanishes on redeploy; asset URLs 404.
  Needs Supabase Storage / S3.
- **No real vision analysis** — Gemini gets a URL string, not the image bytes.
- **Assets are bound to ad campaigns, not to contacts/messages/ventures.**

**The funnel you'd actually want:**
1. Per-venture **asset library** (decks, one-pagers, case-study images) in durable
   storage.
2. On compose / sequence step: **pick or generate** an asset → it attaches (small
   images inline, decks as a **tracked link**, not a heavy attachment that tanks
   deliverability).
3. **Generate-to-attach in one flow**: "make a hero image for this pitch" → renders →
   auto-attaches → stored.
4. **Track the asset**: deck opens/downloads become engagement events that feed the lead
   score and can trigger a follow-up ("opened the deck twice → auto-enroll in the
   warm-lead sequence").
5. **Real vision QA** (multimodal) before an image is allowed to send.

---

## 3. Missing screens / UX (net-new surfaces worth building)

- **Enroll flow** — multi-select on leads → "Add to sequence"; and per-sequence
  enrollment management. (Unblocks the entire engine.)
- **Unified pipeline / funnel view** — counts and drop-off across pulled → enriched →
  good_fit → enrolled → sent → opened → replied → converted. You have every table for
  this; there's no screen.
- **Live sequence dashboard** — per-sequence active/sent/opened/replied, where each
  contact sits, next send time, pause/edit steps.
- **Compose upgrades** — live `EmailPreview` (it exists), token rendering, attachment
  picker, variant compare, spam-lint badge, "why this message" rationale, approval step.
- **Real per-contact timeline** — replace the hardcoded fake timeline in `ContactDrawer`
  with `timeline_activities`/`email_events` (data exists).
- **Bulk actions on leads** — multi-select → enrich / tag / enroll / suppress / export.
- **Saved ICPs** — surface `icp_profiles` in the sourcing form.
- **Deliverability settings** — mailbox pool, warm-up ramp, per-account/per-mailbox
  caps, quiet hours, global frequency cap.

---

## 4. Prioritized plan

**P0 — correctness/security/trust (days):** #1 export auth, #2 GET-unsubscribe,
#3 enrichment status mismatch (stops credit bleed), #4 fake timeline, #6 Resend bounce
webhook, #12 `is_active` default. All small, all currently costing you money, data, or
reputation.

**P1 — connect what's already built (1-2 weeks):** enroll UI (unblocks Stage 4);
inbound ingestion (lights up Stage 7); wire generation → persist → attach to
send/sequence (Stage 2 truth); collapse the two sequence engines into one; unify the two
scoring formulas; add the pre-send preflight gate.

**P2 — the differentiators you asked about (2-4 weeks):** explicit message-intent model
+ per-message rationale; grounded generation off `knowledge_articles`; variant
tournament on the existing A/B tables; asset library + generate-to-attach + tracked-deck
engagement; mailbox pool + warm-up; the funnel view.

**Scope guard:** don't build new AI features on top of a generation layer that isn't
wired to sending, or a reply brain with no inbound feed. Connect the pipe first (P1),
then make the water smart (P2).
