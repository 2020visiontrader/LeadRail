# LeadRail Copilot — Implementation Research

**Scope (locked by user, 2026-08-13):** The in-app chat is a reasoning copilot wired to the agentic layer — *the way Zo operates*. Every user action on the platform (every feature and subfeature) can be asked as a plain-language task and executed automatically, scoped per user account. The copilot asks for scope/permission and checks in when needed. All loading states are plain-language. The thinking layer is visible to the user.

This document is **research + architecture only** — no code. It answers "how do we build this," grounded in LeadRail's actual stack.

---

## 1. The core design problem

"Every feature and subfeature = a plain-language task" is not a chat problem, it's a **capability-surface problem**. Two ways to fail:

- **Hand-write one tool per action.** LeadRail has ~118 API routes. Hand-authoring, versioning, and gating 100+ bespoke tools rots the moment a feature ships without its tool. This is the trap.
- **Give the LLM raw DB/HTTP access.** Fast to demo, unsafe and ungovernable — no per-account isolation, no gating, no audit.

**The answer: one Capability Registry as the single source of truth.** Every platform action is declared once (name, plain-language description, input schema, gate class, owning service fn). The chat tools, the MCP server (already shipped), the confirmation UI, and the audit log all read from that registry. Add a feature → add one registry entry → it's automatically callable from chat, over MCP, gated, and logged. This is the difference between a copilot that covers 20 actions and one that covers *the whole platform* without per-feature chat work.

The 12-tool MCP server + `lib/campaigns/actions.ts` shipped this session are the first slice of exactly this pattern. The research recommendation is to **generalize that into a registry**, not keep adding one-off tools.

---

## 2. Architecture — five layers

```
User prompt (plain language)
      │
┌─────▼──────────────────────────────────────────────────┐
│ 1. CONTEXT ASSEMBLY  (lib/agent/context.ts)             │
│    per-account: ventures, ICP, personas, recent state,  │
│    durable memory digest, platform operating model      │
└─────┬──────────────────────────────────────────────────┘
      │  system prompt = who you are + this account's world
┌─────▼──────────────────────────────────────────────────┐
│ 2. REASONING LOOP  (Claude primary + fallbacks)         │
│    reason → pick tool → observe → continue → respond    │
│    emits stream events for thinking + loading           │
└─────┬───────────────────────────────┬──────────────────┘
      │ tool call                      │ stream events
┌─────▼───────────────────┐   ┌────────▼──────────────────┐
│ 3. CAPABILITY REGISTRY  │   │ 5. STREAM / THINKING UI    │
│    every action, gated, │   │  plain-language thinking,  │
│    account-scoped        │   │  loading, confirm cards    │
└─────┬───────────────────┘   └────────────────────────────┘
      │ executes via
┌─────▼──────────────────────────────────────────────────┐
│ 4. SERVICE FN LAYER  (existing lib/*, RLS-enforced)     │
│    Apollo, Resend, campaigns, CRM, connectors, creative │
└─────────────────────────────────────────────────────────┘
```

### Layer 1 — Context assembly (the "knows your account" part)
Every turn, build a compact context block, never a raw data dump:
- **Platform model:** how LeadRail works (ventures → brands → campaigns/leads/deals/conversations), what the copilot can do. Static, cached.
- **Account state:** this user's ventures, brand IDs, active campaigns, ad account, contact/deal counts, connected integrations (Meta/Notion/Drive/Apollo/Resend status). Live query, cached per turn.
- **Venture grounding:** ICP, pitch, sender persona, lead goal — the `loadVentureContext()` that already exists but isn't wired into the loop.
- **Durable memory:** distilled facts from prior chats (see §6), not transcripts.

Token discipline: context is a *digest*, target a few thousand tokens, with IDs the tools can act on — not the whole CRM.

### Layer 2 — Reasoning loop
Claude as the wrapper brain (this is the "same way you operate" ask), with the existing resilient fallback ladder for outages. The loop already exists in `/assistant`; the research changes are:
1. **De-straitjacket it** — let it converse and reason substantively, not just emit tool-or-final JSON. Native tool-use (parallel tool calls) rather than a hand-rolled ReAct JSON grammar.
2. **Feed it the registry**, not a frozen 23-tool list.
3. **Emit stream events** for thinking + loading (§5).

### Layer 3 — Capability Registry (the key new abstraction)
Each entry:
```
{
  id: "leads.source",
  label: "Source new leads",              // plain language, shown in UI
  describe: (args) => "Searching Apollo for 25 marketing directors in Toronto",
  input: zodSchema,                        // validated before execution
  gate: "SPEND_APOLLO",                    // see §4
  scope: "brand",                          // account | brand | campaign
  run: (ctx, args) => sourceLeads(...)     // wraps existing service fn
}
```
Registry is grouped by family (Sourcing, Outreach, CRM/Pipeline, Campaigns/Ads, Creative, Persona, Connectors, Analytics, Account/Settings). The same registry feeds chat tools **and** the MCP server — one definition, both surfaces.

### Layer 4 — Service functions
Already exist and are RLS-enforced. The registry `run` never touches the DB directly; it calls the vetted service fn under the user's session. This is what keeps "per user account" true at the data layer, not just the prompt layer.

### Layer 5 — Stream / thinking UI (covered in §5).

---

## 3. Complete action surface (what "every feature/subfeature" actually means)

First build step is a **capability audit**: walk the ~118 routes + service fns and classify each. Draft inventory from this session's mapping (WRAP-READY unless noted):

| Family | Actions | Default gate |
|---|---|---|
| Sourcing | search leads (Apollo), enrich/reveal | SPEND (Apollo credits) |
| Outreach | draft, **send email direct** (Resend), send message, enroll in sequence | SEND (real people) |
| CRM / Pipeline | list stages, create/move deal, add note, update lead status, tag | auto |
| Campaigns / Ads | create (PAUSED), **launch** (spend), pause, sync insights, list ad accounts | SPEND on launch only |
| Creative | generate ad copy, generate ad image | auto (own credits, no send) |
| Persona | list, select/update sender persona | auto |
| Connectors | Notion fetch/import, Drive fetch/import | auto (read) |
| Analytics | pull campaign/lead/pipeline metrics, A/B results | auto |
| Account / Settings | read profile, ventures, integration status; connect flows | auto (read) / handoff (OAuth) |
| Conversations | list, read threads | auto |

**Honest gap:** actions requiring an OAuth handshake (connect Meta ad account, connect a new Drive) can't be *completed* by the copilot in-chat — it can start the flow and hand off. Flag these as `HANDOFF`, don't fake them.

---

## 4. Scope-asks + check-ins (the "asking for scopes and checking in" part)

Do **not** gate everything — that makes it feel broken. Gate only three risk classes; everything else just runs:

| Gate | Fires on | UX |
|---|---|---|
| `SPEND` | real money or paid credits (ad launch, Apollo reveal, image gen over threshold) | confirm card: exact amount, then execute |
| `SEND` | outreach to real people (email/DM/sequence enroll) | confirm card: recipient + preview, then execute |
| `DESTRUCTIVE` | irreversible mutation (delete, bulk status change) | confirm card: what changes + count |
| `HANDOFF` | needs OAuth/external step | inline instruction + deep link, no fake success |

**Two interaction patterns, both plain-language:**
- **Scope-ask (clarify-before-act):** when a request is ambiguous or under-specified ("email the new leads" — which leads? which template?), the copilot asks one targeted question before acting, rather than guessing. Cheap to implement: the model is allowed to return a question instead of a tool call.
- **Check-in (confirm-before-commit):** for gated actions, the loop pauses and emits an `awaiting_confirmation` event carrying a structured confirmation card; the UI renders Approve/Cancel; approval resumes the loop with the same tool call. This is a first-class loop state, not a modal bolted on.

Every gated execution writes to the existing `app_logs` / audit trail with the account, action, args digest, and approval record.

---

## 5. Visible thinking + plain-language loading (the "same way you operate" part)

This is a **streaming-events** problem. The loop emits a typed event stream over SSE (the `/assistant` console already streams); the UI renders each type. Reuse the FilmOps **thinking-steps** system already built (animated plain-language step component + vocabulary) — same pattern, LeadRail-skinned per DESIGN.md.

Event types:
| Event | Rendered as |
|---|---|
| `thinking` | greyed reasoning line — "Figuring out which leads match your ICP…" |
| `tool_call` | plain-language loading step from `describe(args)` — "Searching Apollo for 25 marketing directors in Toronto…" |
| `tool_result` | step resolves — "Found 25 leads, 18 with verified emails" |
| `awaiting_confirmation` | confirm card (§4) |
| `message` / `token` | streamed final answer |
| `error` | plain-language failure — "Apollo didn't respond, nothing was charged. Retry?" |

Rules: **never** show a raw tool name, JSON, stack trace, or spinner-with-no-words. Every loading state is a sentence a non-technical operator understands. The `describe()` fn on each registry entry is what makes this cheap and consistent — plain language is authored once, next to the capability.

---

## 6. Memory + long-chat handoff (already designed, folds in here)

- **Durable account memory/graph:** `agent_memory` table — fact rows with optional (subject, predicate, object) triples, distilled from chats, injected into context (§1). This is the "memory + graph" the user asked for.
- **Long-chat compaction:** track a running token estimate per conversation; at a soft threshold emit `compaction_suggested` (banner: "This chat's getting long — start fresh, I'll carry the important context"); at the hard ceiling, stop heavy new work and auto-generate a fixed-schema **carryover memo** (objective / active_context / established_facts / decisions / open_tasks / dont_repeat). "Start fresh (carry context)" opens a new chat seeded with the memo — near-empty token budget, fully oriented. Same mechanism as a good agent handoff.

---

## 7. Model routing & cost

- **Primary:** Claude (the wrapper brain) — reasoning quality is the product here.
- **Cheap lane:** compaction/summarization and plain-language `describe()` fallbacks run on the cheap tier (NIM/Haiku) — don't burn a frontier call on a summary.
- **Resilience:** keep the existing multi-tier fallback ladder so a provider outage degrades instead of dying.
- **Cost control:** context is a digest not a dump; tool results are truncated before re-feeding; long chats compact. These three are what keep per-turn cost sane at full scope.

---

## 8. Per-account isolation (non-negotiable)

- Every registry `run` executes under the user's session; RLS enforces row ownership at the DB — the prompt is *never* the security boundary.
- `scope` field (account/brand/campaign) + existing `ownedCampaign()` / `assertBrandOwned()` helpers assert ownership before any mutation.
- MCP server stays single-tenant per `APP_API_SECRET` until multi-tenant token issuance is built (known gap).
- Client-facing vs owner/operator: current scope is **owner/operator** (can spend + send on connected accounts). If this is ever exposed to clients, the registry needs a per-role capability filter — the registry makes that a one-place change.

---

## 9. Recommended build phases

1. **Capability audit + registry skeleton** — inventory all ~118 routes/service fns, classify family + gate + scope, stand up the registry with the campaigns actions already built as the first entries.
2. **Wire the loop to the registry** — replace the frozen tool list; de-straitjacket reasoning; native tool-use.
3. **Context assembly** — wire `loadVentureContext()` + account state + memory digest into the system prompt.
4. **Stream + thinking UI** — event types + `describe()` plain-language rendering, reusing FilmOps thinking-steps; confirm cards for gates.
5. **Tool surface fill-out** — Sourcing, Outreach (direct send), CRM, Persona, Creative, Connectors registered.
6. **Memory + long-chat handoff** — `agent_memory`, carryover memo, reseed flow.
7. **Hardening** — audit every gated path, verify RLS on each registry entry, load-test streaming.

Deploy each phase via build + restart `svc_uQVqC_NJWMU` on :3200 (not hot-reload — 9p/gVisor breaks inotify).

---

## 10. Risks / honest flags

- **Registry is the linchpin.** If teams keep adding one-off tools instead of registry entries, coverage rots. Enforce "new feature ships with a registry entry" as a rule.
- **OAuth-gated actions can't be fully autonomous** — copilot hands off; don't fake completion.
- **Meta ad launch, real sends, Apollo reveals spend real money/credits** — the gate layer is load-bearing; test the confirm→execute→audit path before trusting it.
- **Multi-tenant MCP** and **client-facing role filtering** are known gaps, not built.
- **First step is verification, not code:** the capability audit is the thing that turns "every feature" from a slogan into a finite, buildable list.
