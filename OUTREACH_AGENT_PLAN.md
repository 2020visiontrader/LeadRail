# LeadRail Agentic Outreach — Phase Plan (Outreach First)

Status: PLAN / not yet built · Owner: aifranckie · Date: 2026-08-11
Method: Fable (Think / Act / Prove). This doc is the source of truth for the Outreach slice.

---

## 0. The vision (context, not scope)

LeadRail = one product, three venture skins (RetentionRail, FilmOps, RENTAHUB). The end state is a
Claude-wrapper **assistant** that operates the whole funnel by tool-use:

`venture → leads → outreach → content → campaign/ads → analytics → training loop (Hermes)`

A user types a goal ("email these leads, follow up, book the repliers") and the agent picks the tools,
acts on that account, and reports. This plan builds the **Outreach** stage first, because it's the wedge:
it turns LeadRail from a dashboard you *look at* into an operator you *delegate to* — the thing people pay for.

---

## 1. Classify

Plan-first, multi-phase feature. Reversible in email (approval-gated). Irreversible cost/risk only appears
in Meta channels (policy + spend), so those are gated behind an explicit go-ahead.

## 2. Define Done (acceptance for the Outreach slice)

On a real venture, from LeadRail AI chat, these two commands run end-to-end:

- **Reach out:** "Email these RetentionRail leads an intro and follow up in 3 days if no reply."
  → agent enrolls them in a sequence, schedules the follow-up, tracks opens/replies.
- **Convert repliers:** "Who replied to the RetentionRail outreach? Message them to book onboarding."
  → agent lists responders (filtered to good-fit), sends an onboarding message + scheduling link.

Verified = both run with **real send + real reply detection**, **per-account scoping**, and a **human-approval
gate that shows the recipient list before anything sends**.

## 3. Evidence (grounded in the code map, 2026-08-11)

| Capability | State | Location |
|---|---|---|
| Agent loop (ReAct JSON) + approval gate | REAL | `lib/agent/loop.ts`, `app/api/agent/*` |
| Tool registry (26 tools, all read/ads — **no messaging**) | REAL | `lib/agent/tools.ts` |
| LLM router (Zo Ask BYOK Anthropic → OpenCode → NIM) | REAL | `lib/ai/router.ts`, `zoask.ts` |
| Email send (Resend + Brevo), open/click tracking | REAL | `lib/integrations/resend.ts`, `brevo.ts`, `lib/tracking.ts` |
| Sequences + durable tick queue + business hours | REAL | `lib/sequences.ts`, `/api/hermes/tick`, `migrations/011` |
| Reply detection + reply classifier + automations | REAL | `stopRepliedEnrollments()`, `lib/reply-classifier.ts`, `lib/automations.ts` |
| Venture persona (sender/pitch/tone/signature/cta) | REAL | `brands` table, `migrations/019` |
| Unified conversations model (multi-channel ready) | REAL | `conversations` + `conversation_messages` |
| Instagram DM **send** | REAL but UNUSED | `replyToDM()` in `lib/social/meta-engagement.ts` |
| Instagram DM **inbound read** | MISSING | no webhook consumer |
| WhatsApp / LinkedIn / SMS / X outbound | SCAFFOLD/NONE | `lib/social/providers.ts` |

**Suppression list, send caps, and email-open pixel already exist** (`migrations/009_outreach_hardening`) —
guardrails are built; we just wire tools to respect them.

## 4. Decide (one recommendation)

Ship **Phase 1 → Phase 2 (pure email) first** — zero Meta dependency, all infra real, working agentic
outreach demo that onboards RetentionRail creators this week. Do **Phase 3 (Instagram) only after** the
Business-IG question is answered, because Meta policy — not our code — is the constraint.

---

## Phase 1 — Make the assistant able to reach out (email)

Add messaging tools to `lib/agent/tools.ts`, each reusing existing libs, each **account-scoped +
approval-gated + logged to `app_logs`/`conversations` + suppression/cap-aware**:

| New tool | Type | Wraps |
|---|---|---|
| `listSequences` | read | sequences for venture |
| `createSequence` | WRITE·sensitive | build sequence + steps from NL; **body grounded in `brands` persona** |
| `enrollLeads` | WRITE·sensitive | insert `sequence_enrollments`, set `next_run_at` |
| `sendOutreach` | WRITE·sensitive | one-off send via Resend/Brevo → log `email_campaigns` + `conversations` |
| `getOutreachStatus` | read | per contact/venture: sent/opened/replied/outcome |

**Done when:** "Email these 5 leads an intro, follow up in 3 days" runs, approval card shows the 5 recipients,
send fires, follow-up schedules, opens/replies track.

## Phase 2 — Responder intelligence + onboarding action (the RetentionRail flow, email)

| New tool | Type | Wraps |
|---|---|---|
| `listResponders` | read | `sequence_enrollments.status='replied'` (+`outcome`) / inbound `conversations`, filtered by venture + optional sequence + timeframe |

- Store an onboarding scheduling link per venture (`brands.onboarding_url`, new column, or reuse `default_cta`).
- Compose the action from existing tools: `listResponders(venture=RetentionRail, outcome=good_fit)`
  → `sendOutreach(each, onboarding template + link)` **or** `enrollLeads(onboarding sequence)`.

**Done when:** "Who replied to RetentionRail outreach? Book them for onboarding" returns the responder list,
agent proposes the onboarding message, approval → sends with the scheduling link.

## Phase 3 — Instagram DM channel (send + read), policy-bounded  ⛔ GATED

**Reality gate — needs the owner's answer first:**
- IG DM API works **only** on an IG **Business/Creator** account linked to a Facebook Page.
- Meta blocks **cold** outbound DMs; sends are allowed only **within 24h** of the user's last message
  (or via approved message tags).
- **Historical DMs sent by hand from a personal IG are unreadable by any API.** If RetentionRail outreach
  went out that way, Phase 3 cannot retroactively pull it — the fix is to route *future* RetentionRail
  outreach through a connected Business IG so every touch is recorded.

If Business-IG is confirmed:
- **3a — Inbound ingestion:** consume Meta messaging webhook → write inbound IG DMs into
  `conversations`/`conversation_messages` (`channel='instagram'`), link to `contacts` by IG handle.
  *This is what makes "who responded on IG" answerable.* (new webhook route + handler)
- **3b — `sendInstagramDM`** agent tool (WRITE·sensitive): wraps existing `replyToDM()`, enabled only for
  contacts inside the 24h window; surfaces window state in the approval card.
- **3c — Attribution:** tag IG threads with venture/campaign so "RetentionRail outreach" is filterable.

---

## Cross-cutting contract (built once, all phases obey)

Every messaging WRITE tool:
1. Server-authenticated `accountId` (never from client body).
2. Human-approval token before send; approval card lists recipients + preview.
3. Respects suppression list, per-account daily send cap, business-hours window.
4. Dedupes by `external_id`; logs to `app_logs` + mirrors to `conversations`.
5. Narrated by the existing venture-grounded thinking layer
   ("Finding RetentionRail responders… 12 replied, 7 good-fit… drafting onboarding invite…").

## Explicitly OUT of the Outreach slice (later phases)

Content-generation pipeline, ad campaign/ad-set builder (tools `createCampaign`/`launchCampaign`/
`analyzeCampaign` already exist — reuse the same agent+approval pattern), Notion-as-template performance
analytics, and the Hermes training loop. Same tool+approval architecture, applied stage by stage.

---

## Open decisions (owner)

1. RetentionRail outreach origin: **personal IG** or **Business/Creator IG linked to a FB Page?**
   (Gates whether Phase 3 can read history at all.)
2. Onboarding action: **DM/email back** vs **scheduling link (Cal.com/Calendly)?**
   (Recommend scheduling link — reliable, avoids IG automation limits.)
3. Approve email-first sequencing (Phase 1→2 now, Phase 3 after Q1)?
