# LeadRail Agent Swarm — Hermes-Orchestrated Architecture & Build Plan

Status: PLAN (Claude architecture) → NIM executes via zo bash, Claude cross-checks each chunk.
Branch: `feat/oss-harvest-remodel`. Next migration number: **037**.

## The problem we're solving

Today: **one** ReAct loop per HTTP request (`lib/agent/loop.ts` `runAgentStream`, `MAX_STEPS=10`, tools run strictly sequentially). That cannot:
- cross-check several parts of the platform at once before answering,
- research the whole platform in parallel,
- **find leads AND run outreach at the same time** (parallel execution that outlives the request).

The user wants a real swarm, with **Hermes as the harness** that coordinates the sub-agents.

## Why Hermes is the right harness (it already exists)

`lib/hermes/agent.ts` already has a **durable job queue**: `hermes_jobs` rows (`status: pending`, `run_at`), `drainDueJobs()` executor, drained by the `/api/hermes/tick` cron. It survives tab close and runs in the background. We extend this from "outreach sequence steps" into "any sub-agent task" — that's the swarm's async execution spine. No new queue infrastructure needed.

## Architecture — orchestrator / worker

```
User goal
   │
   ▼
ORCHESTRATOR (Hermes)  ── lib/agent/orchestrator.ts (new)
   │  plans a DAG of sub-tasks, picks a mode, multiplexes streams, synthesizes
   ├──────────────► SYNC swarm (research / cross-check) — in-request, Promise.all
   │                 ResearchWorker × N  (read-only tools only)
   │                 each = a scoped runAgentStream, events tagged by lane
   │                 orchestrator waits, synthesizes ONE grounded answer
   │
   └──────────────► ASYNC swarm (execute) — enqueued into hermes_jobs
                     LeadSourcingWorker  ┐  run in parallel by the
                     OutreachWorker      ┘  Hermes tick drain, in background
                     progress streamed back to UI via a run/subscribe channel
```

### Two execution modes (the orchestrator chooses)

**A. Synchronous research swarm** — "cross-check X, Y, Z / research everything before answering."
- Orchestrator decomposes into N read-only sub-questions, each dispatched to a `ResearchWorker` (a `runAgentStream` restricted to the read-only tool subset).
- Fan out with `Promise.all`; each worker's `thought/tool/observation` events are tagged `lane: <worker>` and multiplexed into the single SSE stream, so the user sees **parallel thinking lanes live**.
- Orchestrator barrier-joins, then runs one synthesis pass → grounded final answer. Bounded, fast, no queue.

**B. Asynchronous execution swarm** — "find leads and automate outreach at the same time."
- Orchestrator writes a `swarm_runs` row + child `swarm_tasks` (e.g. `source_leads`, `run_outreach`) into the Hermes queue and returns a `runId` immediately.
- The Hermes tick drain executes tasks **in parallel** in the background (each an ExecutionWorker calling the real sensitive tools, gated by the existing approval flow).
- UI subscribes to `runId` progress (`/api/agent/run/:id/stream`, SSE polling the task rows) → live status even after refresh/close.
- Sensitive tools still route through the existing `needs_approval` proposal path — the swarm never spends money or emails a real person without the same confirmation gate.

### Tool partition (already true in `lib/agent/tools.ts`, 38 tools)
- **Read-only (research workers):** listVentures, listCampaigns, getCampaign, getInsights, listLeads, getLead, analyzeCampaign, searchNotion, searchDrive, readNotionPage, readDriveFile, listSequences, listStages, listTags, getPersona, … (~33).
- **Sensitive (execution workers, approval-gated):** launchCampaign, sourceLeads, enrichLead, sendEmail, enrollInSequence.

## Live reasoning-steps fix (fold in first — it's a real bug, not a proxy mystery)

Root cause: in `runAgentStream`, the first event of every step is `thought`, which only fires **after** the blocking `generateChat()` returns. During the model's 3–8s generation there is **zero output** → steps land in a burst with the answer. Fixes:
1. **Emit `step_start` before each `generateChat()` call** (loop.ts) — a live "Working…" step during the thinking window. Handle `step_start` in `AgentConsole.handleEvent` as an active (pulsing) step.
2. Verify SSE actually flushes on prod with a raw curl behind Cloudflare; if buffered, add SSE keepalive padding + `Content-Encoding: identity` on the stream route. (`streamTokens` is a fake pacer — if the answer *pops* in whole rather than typing, the body is being buffered.)

## Data model (migration 037_agent_swarm.sql)
- `swarm_runs`: id, account_id, brand_id, goal, mode ('research'|'execute'), status, created_at, finished_at.
- `swarm_tasks`: id, run_id, account_id, kind, input jsonb, status ('queued'|'running'|'succeeded'|'failed'|'needs_approval'), result jsonb, lane, depends_on uuid[], run_at, created_at, updated_at.
- Reuse `hermes_jobs` drain semantics; `swarm_tasks` is drained the same way from `/api/hermes/tick`.

## Build order (each chunk = one NIM execution via zo bash, Claude cross-checks the diff)

1. **Live-steps fix** (loop.ts `step_start` + AgentConsole handler). Smallest, highest UX value, independently shippable. ← start here
2. **Persistence wiring** (capture `conversationId`, resend it, hydrate on mount) + `GET /api/agent/conversations` list + thread sidebar + New-chat. (Fixes refresh-wipe / multiple windows; backend already supports it.)
3. **Migration 037** `swarm_runs` / `swarm_tasks`.
4. **Orchestrator** `lib/agent/orchestrator.ts` — planner + mode selector + read-only worker fan-out (`Promise.all`) + tagged-lane event multiplexing into the existing SSE. (Mode A, synchronous research swarm.)
5. **Hermes swarm executor** — extend `drainDueJobs()` to run `swarm_tasks` ExecutionWorkers in parallel; `swarm_runs` progress endpoint + UI subscribe. (Mode B, async lead-sourcing + outreach at once.)
6. **AgentConsole multi-lane UI** — render parallel worker lanes + background-run progress cards.

## Lean tiered-cognition model routing (how Thragg + Hermes + swarm stay cheap AND accurate)

The copilot (Thragg in FilmOps / LeadRail AI here) is the **brain**; Hermes is the **dispatcher + budget enforcer**; the swarm is the **hands**. The trick to "leaning them out" is that Hermes tags every sub-task with the *cheapest tier that can do it*, and only escalates on disagreement or real-world stakes. Four cognition tiers:

- **T0 — Plan/Route (cheap, always):** copilot decomposes the goal into a task DAG + picks mode (research vs execute). Structured-JSON planning → runs on **free NVIDIA NIM** (`meta/llama-3.1-8b` / `nemotron`). Near-zero cost.
- **T1 — Swarm workers (cheap, massively parallel):** every ResearchWorker and web-search reasoning agent runs on **free NIM** (nemotron / DeepSeek-R1 via NIM). Web workers pair a grounding provider (Exa / Tavily / SERPAPI) with a cheap reasoning model to read results. Because NIM is free, fanning out 5–10 workers costs ~nothing.
- **T2 — Synthesis + self-consistency (mid, gated):** Hermes joins worker outputs, then runs the critical reasoning **2–3× cheaply** (NIM/OpenRouter) and compares. Agreement → ship the cheap answer. Disagreement → escalate. This *is* the "different reasoning agents decide the best output" — a cheap ensemble vote, not N expensive models every time.
- **T3 — Escalation backstop (accurate, rare):** **Zo Ask (Sonnet, subscription, no spending gate)** or a strong OpenRouter model, invoked ONLY when: T2 self-consistency disagrees, the task is sensitive (spends money / emails a real person), or the user says "think hard." This is the accuracy insurance on an otherwise-free path.

**Backend mapping (honours the model-routing rule):** NVIDIA NIM (free, own key) = T0/T1/first-pass T2 → NIM DeepSeek → Kimi-2 → Hugging Face (OSS/specialized/embeddings where NIM lacks) → OpenRouter (BYOK breadth + the T2 critic) → **Zo Ask omit-model = Sonnet** as the T3 escalation default. Never hardcode a stale `byok:uuid`.

**Where Hermes enforces "lean":** each `swarm_tasks` row carries `model_tier`, `model_id`, `stakes` (`low|spend|send`), and a running `cost_estimate`. Hermes picks the lowest tier satisfying the task's stakes, tracks spend against a per-run budget, and refuses to auto-escalate a sensitive task past the approval gate. So the default path is free NIM end-to-end; money/accuracy is spent only where the task *earns* it.

**One gap to build:** the swarm's web-search workers need a generic web grounding tool (Exa/Tavily) — LeadRail today has `searchNotion`/`searchDrive` but no open-web tool. Add it in the research-swarm chunk (§4).

## Guardrails
- Existing colors/tokens only (DESIGN.md "dark operator console"); no 3D, no decorative motion — only step fade-in + the live active pulse.
- Sensitive tools keep the `needs_approval` gate inside every worker — no autonomous spend/send.
- Every DB write account-scoped (`account_id` from session), same as today.
- Each chunk typechecks before it's considered done; left uncommitted for eyeball test.
