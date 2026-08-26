# LeadRail — Capability & Route Gap Analysis

Date: 2026-08-13 · Baseline: LeadRail = 140 API routes, 71 lib modules, 20 pages, 22 migrations, 60+ capabilities.
Reference repos: adclaw (Apache, primary template), helio (AGPL, feature reference only), opensoul + pendpost (MIT, agent/approval patterns).

## The core insight
LeadRail already HAS adclaw's *agent engine*: ReAct loop (`lib/agent/loop.ts`), shared 42-tool registry, MCP **server** (`/api/mcp`), LLM router w/ fallback (`lib/ai/router.ts`), streaming console (`/api/agent/stream` + `/assistant`), session history (migration 022), approval gate. What LeadRail is missing vs adclaw is the **operator control plane** (management UIs) and a **multi-persona roster** — not the engine. "Adopt adclaw in full" ≈ build the control plane + personas.

---

## GAP MATRIX A — adclaw (primary template)

| adclaw capability | adclaw routes | LeadRail today | Verdict |
|---|---|---|---|
| Multi-persona team + coordinator/synthesis | `/agents/personas/*` (CRUD+templates) | only per-venture *sender* persona (mig 019) | **MISSING** (partial) |
| Skills management (CRUD, enable/disable, hub install, quality+security scan) | `/api/skills/*` (18 eps) | `/skills` GET-only 13-skill catalog | **PARTIAL → build CRUD+scan** |
| Model/provider settings (registry, active, fallback, per-persona, usage) | `/api/models/*` | router hardcoded in code | **PARTIAL → expose as config** |
| MCP **client** manager (consume external MCP servers) | `/api/mcp/*` (CRUD/test/tools) | LeadRail only *serves* MCP | **MISSING** |
| Cron jobs + heartbeat (self-serve scheduled agent tasks) | `/api/cron/*`, `/api/config/heartbeat` | Hermes tick + automations engine (no UI) | **PARTIAL → add UI+heartbeat** |
| Env/secrets manager (masked, in-app) | `/api/envs/*` | secrets via platform env only | **MISSING** |
| Diagnostics (health, recent errors, restart) | `/api/diagnostics/*` | `/logs` only | **PARTIAL** |
| Agent workspace memory files (editable MD/HEARTBEAT) | `/api/agent/files`, `/memory` | none | **MISSING** |
| Agent running-config (max steps, input length) | `/api/agent/running-config` | `MAX_STEPS` hardcoded | **MISSING (small)** |
| Always-On Memory (vector store + consolidation, multimodal) | `/api/memory/*` | token-based convo carryover only | **MISSING (big)** |
| Chat console (SSE, thinking/tool display) | `/api/console/push-messages` | `/assistant` + `/api/agent/stream` | **HAVE** (remodel for look) |
| Session chat history | `/api/chats/*` | `agent_conversations` (mig 022) | **HAVE** |
| Local models / Ollama | `/api/local-models`, `/api/ollama-models` | cloud router | **SKIP** (hosted SaaS) |
| Multi-channel bots (Telegram/Discord/Feishu) | `/api/config/channels` | IG conversations + email inbox | **DEFER** (web-app-first) |

## GAP MATRIX B — helio (the "most complete platform" diff; feature reference only, no code)

| helio capability | LeadRail today | Verdict |
|---|---|---|
| Visual journey builder (DAG: wait/split/A-B/branch/webhook nodes) | linear Hermes sequences | **MISSING (big)** — top CRM gap |
| Segments (rule builder over contacts) | tags + ICP, no segment engine | **MISSING** |
| Behavioral event tracking + analytics (attribution/funnel/retention cohorts) | overview KPIs + campaign analytics | **MISSING (big)** |
| Web forms + landing pages (lead capture) | none | **MISSING** |
| Booking/scheduling pages | none | **MISSING** |
| Public REST gateway + API keys + OpenAPI | internal routes + MCP only | **MISSING** |
| Email WYSIWYG builder + custom sending-domain SPF/DKIM | templates + Resend/Brevo + tracking | **PARTIAL** |
| SMS + web push + in-app message channels | email + social only | **MISSING** |
| NL→segment / NL→journey / NL→email drafting | generate content/outreach/sequence | **PARTIAL** |
| Predictive scoring (churn/conversion, BYO model) | rule-based lead scoring | **PARTIAL** |
| Connector import (Klaviyo/HubSpot/Mailchimp, Shopify/Salesforce) | Apollo/Notion/Drive/Meta | **PARTIAL** |
| White-label multi-tenancy | venture skins + RLS | **HAVE** |
| SCIM/SSO/2FA, self-hosted backups/updates, Data Studio | JWT sessions; Zo/Supabase-managed | **DEFER / SKIP** (enterprise; exists in FilmOps) |

## GAP MATRIX C — opensoul + pendpost (agentic governance patterns, MIT)

| Pattern | LeadRail today | Verdict |
|---|---|---|
| Durable approval workflow: `pending/approved/rejected/revision_requested` + comments + actor tracking | in-loop `needs_approval` only (ephemeral) | **MISSING → build approvals table** |
| No-self-approval + edit-invalidates-approval | none | **MISSING** |
| Payload redaction on approval/audit | partial (webhooks redact) | **PARTIAL** |
| Heartbeat wakeup (approval resumes agent) | none | **MISSING** |
| Config revision history + rollback | none | **MISSING** |
| Cost/budget tracking per venture/agent + caps | `credits.ts` usage billing | **PARTIAL → add budgets** |
| API=MCP parity test | shared registry (good), no test | **PARTIAL → add test** |
| Auto-approve policy w/ manual-lane exclusion | none | **MISSING** |
| Chain-of-command org / IDE adapters (Codex/Cursor) | n/a | **SKIP** (not LeadRail's model) |

---

## Implementation backlog (prioritized, opinionated)

### TIER A — adclaw control plane + personas (the "adopt adclaw" core)
A1. **Persona roster + coordinator** — personas table+CRUD API+UI; multi-persona with @mention routing; one coordinator runs synthesis in `lib/agent/loop.ts`. *(big)*
A2. **Skills management** — turn `/skills` into full CRUD + enable/disable + import the harvested ~350-skill library + quality/security scan. *(med)*
A3. **Model/provider settings UI** — expose `lib/ai/router.ts` as configurable providers + active/fallback + per-persona model + usage. *(med)*
A4. **MCP client manager** — let LeadRail *consume* external MCP servers (connect/test/list-tools/enable). *(med)*
A5. **Cron + heartbeat UI** — self-serve scheduled agent tasks over the existing Hermes/automations engine. *(med)*
A6. **Env manager + Diagnostics + Agent workspace files + running-config** — 4 small operator surfaces. *(small each)*

### TIER B — durable agentic governance (opensoul + pendpost)
B1. **Approvals workflow** — approvals table (typed states + revision), comments, actor tracking, payload redaction, no-self-approval, edit-invalidates. *(med)*
B2. **Budgets** — per-venture/agent caps on top of `credits.ts`. *(med)*
B3. **API=MCP parity test** + expand tool coverage. *(small)*
B4. **Always-On Memory** — pgvector on Supabase + consolidation. *(big)*

### TIER C — helio CRM/platform completeness
C1. **Visual journey builder** (DAG) — evolve `lib/sequences.ts`. *(big, highest CRM value)*
C2. **Segments** rule builder. *(med)*
C3. **Behavioral event tracking + analytics** (attribution/funnel/retention). *(big)*
C4. **Forms + landing pages**, **booking pages**, **public REST gateway + API keys**, **email WYSIWYG + domain auth**, **SMS/push/in-app channels**. *(med each)*

### Deliberately SKIP (with reason)
- Local models / Ollama — LeadRail is hosted; cloud router is correct.
- IDE adapters (Codex/Cursor/OpenClaw) — not LeadRail's execution model.
- Self-hosted backups/updates — Zo/Supabase managed.
- SCIM/SSO/2FA, chain-of-command org, chat-platform bots — defer (enterprise / web-app-first).

---

## Recommended build order
Tier A (A1→A6) first — it's the "adopt adclaw" ask and rides on infra LeadRail already has. Then B1 (approvals) since it hardens everything in A. Then C1 (journey builder) as the flagship CRM gap. Everything on branch `feat/oss-harvest-remodel`, phase-by-phase, typecheck-gated, reviewed against this doc before each next phase.

---

## LOCKED EXECUTION ORDER (2026-08-13) — approved: clean-room, no AGPL code copied

Confirmed by user: adopt structure/setup from all **permissive** repos (adclaw Apache; opensoul, pendpost, MARA, digital-marketing-pro, marketing-os-starter, kai MIT subset), rebuilt in LeadRail's TS. helio/socialflow/fromHello = concept reference only (no code). adclaw look rides on LeadRail's Tailwind (no Ant Design swap).

Sonnet executes phase-by-phase; Opus reviews each diff against this doc before the next.

1. **A0 — Provider/Model system** (adclaw provider registry + model factory + active/fallback + per-persona hook + usage + Settings→Models UI). Replaces hardcoded `lib/ai/router.ts`/`models.ts`. ← IN PROGRESS
2. **A1 — Persona roster + coordinator** (multi-persona, @mention routing, synthesis). Uses A0 per-persona model.
3. **A2 — Skills management + ~350-skill harvest** (permissive skill content → registry CRUD + enable/disable + quality/security scan).
4. **A4–A6 — control surfaces** (MCP client manager, cron+heartbeat UI, env manager, diagnostics, agent workspace files, running-config).
5. **B1 — durable approvals** (opensoul/pendpost: typed states + revision + comments + redaction + no-self-approval + edit-invalidates). **B2** budgets, **B3** API=MCP parity test.
6. **B4 — Always-On Memory** (pgvector consolidation).
7. **C1 — visual journey builder** (flagship CRM gap), then **C2** segments, **C3** analytics, **C4** forms/landing/booking/REST-gateway/email-builder/SMS-push-in-app.
8. **Frontend restyle** (adclaw look in Tailwind: slate + #615CED glass, persona-tab chat console) applied across surfaces as they land.

---

## NAMED PRODUCT-SETUPS → LeadRail build mapping (clean-room; no AGPL/no-license code copied)

User wants socialflow's, helio's, and fromHello's *setups*. All three decompose into phases already in the plan — plus one new orchestration phase. Infra is kept LeadRail-appropriate (Supabase/Postgres), NOT their heavyweight stacks.

### socialflow — 6-agent pipeline (Scout→Planner→Creator→Reviewer→Publisher→Analyst), 12 platforms, Ollama, encrypted creds
- **Ollama / "runs local"** → **already A0**: add Ollama as an OpenAI-compatible provider in the registry. No extra work.
- **Encrypted creds** → **already A0**: AES-GCM key vault.
- **6-agent pipeline** → NEW **phase A1b — Content Pipeline**: each stage is a persona (A1 roster) wired as a DAG via a coordinator. Scout = trend/signal discovery (web search + RSS), Planner = calendar, Creator = generation (exists: `lib/ai/generation.ts`), Reviewer = **B1 approval + quality-gate** (regex PII/credential + brand-voice scan), Publisher = **existing** social routes (Meta/IG/FB/Threads/Buffer/GHL — 20 routes), Analyst = **C3** analytics.
- **12 platforms** → LeadRail already publishes to 6; extend in **C4**.

### helio — CDP + segmentation + cross-channel journeys + AI copilot
- **CDP** → **C3**: behavioral event tracking + unified profile (contacts/timeline already exist).
- **Segmentation** → **C2**: segment rule builder.
- **Cross-channel journeys** → **C1**: visual journey builder (DAG: wait/split/A-B/webhook across email/SMS/push/in-app).
- **AI copilot** → **already have it** (`/assistant`), upgraded by A0+A1.
- **INFRA NOTE (decisive):** helio uses ClickHouse + Redpanda/Kafka. LeadRail does **NOT** adopt those. Events + analytics live in **Postgres** (partitioned tables + materialized views) on Supabase; the existing Hermes tick/job queue replaces Kafka. ClickHouse is a *future scale* option only, not v1.

### fromHello — email/SMS/in-app/push/ad-audiences, visual journey builder, 8 agents w/ human approval
- No code exists (waitlist) → pure capability target.
- **Visual journey builder** → **C1** (the centerpiece; same as helio journeys).
- **Channels: email** (exists) **+ SMS/push/in-app** → **C4**; **ad-audiences** → push segments to Meta Custom Audiences via the existing Meta integration.
- **8 agents + human approval** → **A1** persona roster + **B1** durable approval (opensoul/pendpost pattern).

### Net new work these three add beyond the existing plan
Just **A1b (Content Pipeline orchestration)** and pushing **C4** channels (SMS/push/in-app + Meta Custom Audiences) up in priority. Everything else was already A0/A1/B1/C1/C2/C3. Revised order: A0 → A1 → A1b → A2 → B1 → C1 → C2 → C3 → C4 → A4–A6 → B4.
