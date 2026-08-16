# LeadRail Copilot — Remediation & Completion Plan

Status: PLAN / ready to delegate · Date: 2026-08-16
Author: architecture + review (Opus). Execution: delegated to NIM / OpenRouter executor models.
Companion docs: `OSS_INTEGRATION_PLAN.md` (what was harvested), `COPILOT_IMPLEMENTATION_RESEARCH.md` (the Capability Registry thesis), `GAP_ANALYSIS.md`, `SECURITY_FIX_PLAN.md`.

---

## 0. Operating model

**Roles are fixed. Do not blur them.**

| Role | Who | Does | Never does |
|---|---|---|---|
| Architect / Reviewer | Opus | Writes this plan, defines contracts, reviews every diff against acceptance criteria | Writes or runs implementation code |
| Executor | NIM / OpenRouter model | Writes code, runs typecheck/build, reports diffs | Changes contracts, invents scope, touches files outside its packet |
| Operator | You | Runs the harness, approves phase gates, merges | — |

**Phase gate rule:** a packet is not done until `npx tsc --noEmit` and `npm run build` both pass AND the diff has been reviewed against the packet's acceptance criteria. Never start packet N+1 with N unreviewed.

**Branch:** `feat/copilot-remediation`. One commit per packet, message = packet id + title.

---

## 1. Executor model routing

Route by *failure cost*, not by task size. Weak models fail silently on ambiguity, so anything touching auth, approval state, or tenant scoping gets the strongest tier plus mandatory human review.

| Tier | Use for | Candidate models |
|---|---|---|
| A — strong | Phase 0 (security), migrations, anything touching `account_id` / approval state | `deepseek-ai/deepseek-r1` (NIM), `qwen/qwen3-coder-480b` (OpenRouter), `moonshotai/kimi-k2` |
| B — mid | Phase 1–4 feature wiring, route handlers, store functions | `nvidia/llama-3.3-nemotron-super-49b` (NIM), `deepseek/deepseek-chat` (OpenRouter free) |
| C — cheap/bulk | Phase 5 content harvest, mechanical renames, JSON normalization | `z-ai/glm-4.6`, `qwen/qwen3-8b`, any free-tier instruct model |

Keys live in the operator's environment. `NVIDIA_API_KEY` is already consumed by `lib/agent/embeddings.ts` — reuse the same env var; do not introduce a second one.

**Executor prompt preamble** (prepend to every packet):

```
You are an executor. Implement EXACTLY the packet below against the repo at
/Users/franckiemacair/Desktop/LeadRail. Rules:
1. Touch ONLY the files listed under "Files". If you believe another file must
   change, STOP and report why — do not change it.
2. Do not rename exported symbols, change function signatures, or alter DB
   column names unless the packet says to.
3. Preserve the existing comment style: explain WHY, and mark additive changes
   as additive.
4. After editing run: npx tsc --noEmit && npm run build. Paste both outputs.
5. Output a unified diff of every file you changed. No summary prose.
If any instruction is ambiguous, STOP and ask one question. Do not guess.
```

---

# PHASE 0 — Security. Do this first, review every line.

Three defects let a client execute sensitive actions without a valid approval. They compound: #0.1 alone is exploitable, #0.1 + #0.2 together mean a forged request can launch paid campaigns and email real leads.

---

## Packet 0.1 — Gate execution on approval state

**Problem.** `lib/agent/loop.ts` resume path (both `runAgent` and `runAgentStream`) accepts `input.approve = {tool, args}`, checks only `TOOLS[tool].sensitive`, calls `markApprovedByToolAndArgs` best-effort, then executes. It never reads the approval row's state. `POST /api/approvals/:id` with `decision:'rejected'` only updates a row — it blocks nothing. **A rejected proposal can be executed by resubmitting the same `{tool,args}`.** The self-approval guard and edit-invalidation logic in `lib/approvals/store.ts` therefore protect nothing at execution time.

**Contract.** Execution requires a persisted approval row that is `approved`, matches `hashArgs(args)`, belongs to this account, and has not already been consumed. Consumption is atomic (single-use — no replay).

**Files**
- `migrations/037_approval_execution.sql` (new)
- `lib/approvals/store.ts` (add one exported fn + extend the state union)
- `lib/agent/loop.ts` (replace the two `input.approve` blocks)
- `app/api/agent/route.ts`, `app/api/agent/stream/route.ts` (accept `approvalId`)
- `src/components/AgentConsole.tsx` (send `approvalId`)

**Steps**

1. Migration `037_approval_execution.sql`, idempotent, matching the style of 028:
   - `ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_state_check;`
   - re-add with `CHECK (state IN ('pending','approved','rejected','expired','invalidated','executed'))`
   - `ALTER TABLE approvals ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ;`
   - `CREATE INDEX IF NOT EXISTS idx_approvals_account_tool_hash ON approvals(account_id, tool, args_hash);`

2. In `lib/approvals/store.ts`:
   - extend `ApprovalState` with `'executed'`
   - add:
   ```ts
   export class ApprovalExecutionError extends Error {
     constructor(public code: 'not_found'|'not_approved'|'args_mismatch'|'already_executed', msg: string)
   }
   /** Atomically consume an approved approval for execution. Single-use:
    *  the UPDATE is conditioned on state='approved' so a concurrent second
    *  call loses the race and throws already_executed. */
   export async function consumeApprovalForExecution(
     accountId: string, approvalId: string, tool: string, args: Record<string, any>,
   ): Promise<void>
   ```
   - implementation: fetch row by `id` + `account_id`; throw `not_found` if absent; throw `args_mismatch` if `row.tool !== tool || row.args_hash !== hashArgs(args)`; throw `already_executed` if `state === 'executed'`; throw `not_approved` for any state other than `approved`; then `UPDATE approvals SET state='executed', executed_at=now(), updated_at=now() WHERE id=$1 AND account_id=$2 AND state='approved'` and throw `already_executed` if zero rows returned.

3. In `lib/agent/loop.ts`, `RunAgentInput.approve` becomes `{ approvalId: string; tool: string; args: Record<string, any> }`. Replace **both** approve blocks (≈line 296 in `runAgent`, ≈line 434 in `runAgentStream`) with:
   ```ts
   if (input.approve) {
     const { approvalId, tool, args } = input.approve;
     if (!TOOLS[tool]?.sensitive) { /* existing error return/emit */ }
     try {
       await consumeApprovalForExecution(accountId, approvalId, tool, args);
     } catch (e: any) {
       // HARD FAIL — never fall through to execution.
       const msg = e?.code === 'not_approved'
         ? 'That action has not been approved (or was rejected) and cannot run.'
         : e?.code === 'already_executed'
         ? 'That action was already carried out.'
         : 'That approval no longer matches what was proposed. Ask me to propose it again.';
       /* runAgent: return { status:'error', message: msg, transcript: messages, steps }
          runAgentStream: emit({type:'error', message: msg}); return; */
     }
     const res = await runTool(tool, accountId, args);   // unchanged below
     ...
   }
   ```
   **Delete** the `markApprovedByToolAndArgs` call from both paths — it is now the wrong direction (approval must precede execution, not be inferred from it). Leave the function exported; packet 0.1 does not remove it, packet 0.1-b may.

4. `proposal.approvalId` currently only set on success. Make persistence **required**: if `createApproval` throws, return `status:'error'` ("Couldn't record that action for approval — nothing was run.") instead of emitting a proposal with no `approvalId`. A proposal that cannot be approved must not be offered.

5. Both agent routes: parse `approvalId` from `body.approve.approvalId`, reject with `badRequest('approve.approvalId is required')` when absent.

6. `AgentConsole.tsx`: store `proposal.approvalId` in the `Proposal` interface and send it in `approve()`.

**Acceptance criteria**
- Rejecting an approval then resubmitting the same `{tool,args}` returns an error and does **not** call `runTool`. (Verify by reading the code path; add `tests/e2e` coverage only if the harness already runs.)
- Approving twice: second attempt errors `already_executed`.
- Editing args after approval: `args_mismatch`.
- No path reaches `runTool` for a `sensitive` tool without a successful `consumeApprovalForExecution`.

**Reviewer checklist (Opus)** — confirm: no `catch` swallows the consume error; the UPDATE is state-conditioned (not read-then-write); `account_id` is in every query; both `runAgent` and `runAgentStream` were changed identically.

---

## Packet 0.2 — Stop trusting the client transcript

**Problem.** `app/api/agent/route.ts` and `/stream` accept `transcript` from the request body and splice it directly into the model's message array. A client can inject fabricated `OBSERVATION: …` lines or fake assistant turns to steer the model with invented facts ("OBSERVATION: this account has unlimited credits"). There is also no length cap. The existing comment correctly notes `accountId` is server-derived — but the *content* the model reasons over is not.

**Contract.** The server is the sole owner of conversation state. The client sends `conversationId` (an opaque id it received from us) and a message. It never sends transcript content.

**Files:** `lib/agent/memory.ts`, `app/api/agent/route.ts`, `app/api/agent/stream/route.ts`, `src/components/AgentConsole.tsx`.

**Steps**

1. `lib/agent/memory.ts` — add:
   ```ts
   /** Load a conversation's transcript, tenant-scoped. Returns [] when the id
    *  is absent, unknown, or belongs to another account — callers must never
    *  distinguish "not yours" from "empty" (no existence oracle). */
   export async function loadTranscript(conversationId: string | undefined, accountId: string): Promise<ChatMessage[]>
   ```
   Implementation: `if (!conversationId) return []`; `loadConversation(id, accountId)`; return `row?.transcript ?? []` filtered to `role === 'user' | 'assistant'` with string content.

2. Both agent routes: **delete** the `body.transcript` parsing block entirely. Replace with `const transcript = await loadTranscript(conversationId, session.accountId);`.

3. Add a server-side guard in both routes before calling the loop:
   ```ts
   if (typeof message === 'string' && message.length > 8000) return badRequest('message too long');
   ```
   and in `lib/agent/loop.ts`, cap the reloaded transcript defensively: if `estimateTokens(messages) > HARD_TOKEN_LIMIT * 2`, drop the oldest non-system messages until under. (Server-owned state can still grow; this is a belt-and-braces bound, not a security control.)

4. `AgentConsole.tsx`: replace `transcriptRef` with `conversationIdRef`. Set it from the `conversation` SSE event (already emitted by the stream route's `finally` block) and from `needs_approval`/`final` — note the stream currently sends `conversationId` only in the trailing `conversation` event, which is sufficient. Send `{ message, brandId, conversationId }`.

**Acceptance criteria**
- Neither agent route reads `body.transcript`. Grep must return zero hits.
- Posting a `conversationId` belonging to a different account yields an empty transcript, not an error and not another account's data.
- A page refresh mid-conversation, then sending a follow-up with the same `conversationId`, continues the thread with full prior context. (This packet fixes persistence as a side effect — see Phase 1.2.)

**Reviewer checklist** — confirm `loadTranscript` filters by `account_id` in the query, not after; confirm no route path still accepts client transcript; confirm the `approve` resume path also reloads server-side (it must — that path previously relied on the round-tripped transcript).

---

## Packet 0.3 — Close the MCP server bypass

**Problem.** `app/api/mcp/route.ts` authenticates with one shared static `APP_API_SECRET`, resolves account via `MCP_ACCOUNT_ID` env (acknowledged multi-tenant TODO), and `tools/call` invokes `runTool` directly with **no sensitivity check and no rate limit**. Any holder of that secret can call `launchCampaign`, `sendEmail`, `sourceLeads` — spending money and emailing real people — with zero approval. The header comment justifies this as "MCP callers are already machine-authenticated," which is doing too much work for a single static shared secret.

**Contract.** MCP callers get read + safe-write tools by default. Sensitive tools require an explicit per-key opt-in, and every sensitive MCP call writes an `approvals` row in state `executed` for audit.

**Files:** `migrations/038_mcp_keys.sql` (new), `lib/mcp/keys.ts` (new), `app/api/mcp/route.ts`.

**Steps**

1. Migration: table `mcp_api_keys` — `id UUID PK`, `account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE`, `label TEXT NOT NULL`, `key_hash TEXT NOT NULL UNIQUE` (sha256 of the bearer token — never store the token), `allow_sensitive BOOLEAN NOT NULL DEFAULT false`, `last_used_at TIMESTAMPTZ`, `revoked_at TIMESTAMPTZ`, timestamps. RLS enabled, no anon policies (matches 028). Index on `key_hash`.

2. `lib/mcp/keys.ts`: `export async function resolveMcpKey(bearer: string): Promise<{ accountId: string; allowSensitive: boolean } | null>` — sha256 the bearer, look up by `key_hash`, reject when `revoked_at IS NOT NULL`, best-effort update `last_used_at`.

3. `app/api/mcp/route.ts`:
   - keep the legacy `APP_API_SECRET` path **only** when no `mcp_api_keys` row matches, and when it is used force `allowSensitive = false`. This preserves today's single-tenant owner setup without preserving today's blast radius.
   - in `tools/call`: `if (TOOLS[name]?.sensitive && !allowSensitive) return rpc(id, {content:[{type:'text', text:'This tool requires an approval-enabled key.'}], isError:true})`
   - on a permitted sensitive call, `await createApproval(accountId, {...})` then immediately mark `executed` — so the audit trail covers machine callers too.
   - simple in-process rate limit: max 60 `tools/call` per key per minute; over limit → JSON-RPC error `-32029`.

**Acceptance criteria:** a legacy `APP_API_SECRET` caller can list and call non-sensitive tools and is refused every sensitive tool. A key with `allow_sensitive=true` can call them and leaves an `approvals` row per call.

---

# PHASE 1 — Turn on what's already built

Three subsystems are fully implemented and completely disconnected. These are the cheapest wins in the repo: small diffs, large user-visible effect, near-zero risk.

---

## Packet 1.1 — Give durable memory an ingestion path

**Problem.** `recordFact()` in `lib/agent/memory.ts` is implemented, embeds via NIM, writes to `agent_memory` — and **is called from nowhere**. Grep confirms zero callers. So `recallMemoryDigest` (plus `semanticRecall`, the embeddings module, and the tuned 0.25 similarity floor) reads a table nothing ever writes. The entire semantic-memory layer is inert.

**Contract.** The agent can deliberately remember a durable fact via a tool, and passively extracts facts at conversation end. Memory is account-scoped and user-visible.

**Files:** `lib/agent/tools.ts`, `lib/agent/loop.ts`, `app/api/agent/route.ts` + `/stream`, `migrations/039_memory_ui.sql` (optional), `app/api/knowledge` (reuse if it already fronts `agent_memory` — check first).

**Steps**

1. Add to `TOOLS` in `lib/agent/tools.ts` (non-sensitive — internal write, no spend, no external effect):
   ```ts
   rememberFact: {
     title: 'Remember a fact',
     description: 'Save a durable fact about this account, its ventures, preferences, or people, so you recall it in future chats. Use when the user tells you something worth remembering long-term (a preference, a constraint, a decision, who someone is). Do NOT use for one-off task details.',
     inputSchema: obj({ fact: S.string, subject: S.string, predicate: S.string, object: S.string }, ['fact']),
     zod: z.object({ fact: z.string().min(3).max(500), subject: z.string().optional(), predicate: z.string().optional(), object: z.string().optional() }),
     run: async (accountId, a) => { await recordFact(accountId, a); return { remembered: a.fact }; },
   },
   forgetFact: { /* delete by id; list via listFacts */ }
   listFacts: { /* recent N facts for the account, so the user can audit memory */ }
   ```
   Import `recordFact` from `@/lib/agent/memory`. Add a `deleteFact(accountId, id)` and `listFacts(accountId, limit)` to `memory.ts` (both tenant-scoped, best-effort).

2. Add one line to the `HOW YOU WORK` block in `systemPrompt()` (`lib/agent/loop.ts`):
   `'- When the user tells you something durable about them, their ventures, or their preferences, call rememberFact so you know it next time. Never remember secrets, credentials, or one-off task detail.'`

3. Passive extraction: in `generateCarryover`, the memo already produces `established_facts[]`. In both agent routes, after `saveConversation`, fire-and-forget: for each `established_facts` entry on a **compaction** event only (not every turn — too noisy), call `recordFact`. Gate behind `compaction === 'soft' | 'hard'` so it runs once per long chat, not per message.

4. Guard rails in `recordFact`: reject facts matching the existing `SECRET_KEY_PATTERN`-style heuristics (reuse `redactArgs`' regex from `lib/approvals/store.ts` — export it) and cap at 500 chars. Never store anything that looks like a token or key.

**Acceptance criteria:** telling the assistant "remember that we only target Series A and B" writes an `agent_memory` row with a non-null embedding; a *new* chat's `loadAgentContext` digest contains it; `listFacts` returns it; `forgetFact` removes it.

**Reviewer checklist** — confirm `rememberFact` is NOT marked sensitive (it would deadlock the loop on approval for a harmless internal write); confirm the secret-pattern guard exists; confirm passive extraction is gated to compaction and is fire-and-forget (never blocks the response).

---

## Packet 1.2 — Wire conversation persistence + long-chat handoff

**Problem.** Three built pieces, none connected:
- `saveConversation` writes rows and returns an id → `AgentConsole` never stores it. Refresh = chat gone.
- `runAgentStream` emits `compaction_suggested` → `AgentConsole.handleEvent` has **no branch for it**. Silently dropped.
- `POST /api/agent/carryover` generates and saves a carryover memo → nothing in the UI ever calls it. The `from` reseed param on both agent routes is therefore unreachable.

**Contract.** Conversations survive refresh, are listable, and when one gets long the user is offered a one-click "continue in a fresh chat" that carries context forward.

**Files:** `app/api/agent/conversations/route.ts` (new), `lib/agent/memory.ts`, `src/components/AgentConsole.tsx`, `src/components/AssistantDock.tsx`.

**Steps**

1. `lib/agent/memory.ts` — add `listConversationsForAccount(accountId, limit = 30)` returning `{id, title, updated_at, token_estimate}` (no transcript — keep the list cheap).
2. New route `GET /api/agent/conversations` → that list, session-scoped, `withApi`-wrapped. Also `GET /api/agent/conversations/:id` returning the transcript for rehydration (reuse `loadConversation`).
3. `AgentConsole.tsx`:
   - hold `conversationId` in a ref (set from the `conversation` SSE event — see packet 0.2)
   - add a `compaction_suggested` branch in `handleEvent` → `setCompaction({level, tokenEstimate})`
   - render a banner when set. `soft`: "This chat is getting long — start a fresh one and I'll carry the context over." `hard`: same, worded as a recommendation, styled with the warn colour already used by the approval card (`#D97706`).
   - the banner's button: `POST /api/agent/carryover {conversationId}` → then reset local state and set `pendingFrom = conversationId`, which is sent as `from` on the next message.
   - on mount, accept an optional `conversationId` prop and rehydrate turns from `GET /api/agent/conversations/:id`.
4. `AssistantDock.tsx`: add a collapsed history list in the context column (reuse the existing `ActivityRow` visual language) listing recent conversations; clicking one sets `AgentConsole`'s `conversationId` prop.

**Acceptance criteria:** refresh mid-chat and the thread is still there; crossing `AGENT_SOFT_TOKENS` shows the banner exactly once; clicking through produces a new chat whose first turn already knows the objective and open tasks from the prior one.

**Reviewer checklist** — confirm the compaction banner is not re-shown on every subsequent turn; confirm `from` is only sent once; confirm the conversations list route does not return transcripts.

---

## Packet 1.3 — Small correctness fixes (bundle into one commit)

Low risk, do them together. Tier C executor.

1. `src/components/AgentConsole.tsx` — `TOOL_VERB` maps `listContacts`; the real tool is `listLeads`. The friendly label never fires. Fix the key and add verbs for every tool currently missing one (`listLeads`, `getLead`, `sourceLeads`, `enrichLead`, `draftOutreach`, `sendEmail`, `listSequences`, `enrollInSequence`, `listStages`, `createDeal`, `moveDeal`, `addNote`, `updateLeadStatus`, `listTags`, `tagLead`, `getPersona`, `updatePersona`, `generateAdCopy`, `importAsset`, `listAdSets`, `listAds`, `listAssets`, `getInsights`, `readNotionPage`, `readDriveFile`, `rememberFact`).
2. `lib/agent/loop.ts` — `const toolCalls: Record<string, number> = {}` in `runAgent` is declared and never used (only the stream variant uses it). Either apply the same per-tool cap as the stream variant (**preferred** — the two paths should behave identically) or delete it. Choose apply.
3. `lib/agent/loop.ts` `summarizeProposal` has a `pauseCampaign` branch, but `pauseCampaign` is not marked `sensitive` — dead code and a signal of intent drift. Decide explicitly: pausing *stops* spend, so leave it non-sensitive and **delete the dead branch**. Note the decision in a comment so it isn't re-added.
4. `lib/agent/loop.ts` — `runAgent` and `runAgentStream` have diverged: the stream variant caps repeat tool calls at 2, `runAgent` does not. After fix #2 they should be identical. Add a comment at the top of `runAgentStream`: "Keep behaviourally identical to runAgent — any loop-control change goes in both."

**Acceptance criteria:** every tool in `TOOLS` has a `TOOL_VERB` entry (assert this with a one-line dev-only check or a comment listing the invariant); the two loop variants have identical loop-control logic.

---

# PHASE 2 — The Capability Registry

This is the architectural fix, and it is the one `COPILOT_IMPLEMENTATION_RESEARCH.md` already called for. Read §1 and §2 of that doc before starting; this packet implements its recommendation.

**Problem.** `lib/agent/tools.ts` hand-writes 35 tools against ~118 API routes. The research doc names this exact approach "the trap" — every new feature ships without its tool, and the system prompt's claim that the copilot "understands the whole platform" becomes false. Today the assistant has **no** tools for: journeys, segments, content pipeline & publishing, forms, budgets, notifications, approvals, scheduled tasks, companies, activities, cases, partners, territories, knowledge, analytics/overview, inbox reply, templates, ICP, suppressions, social publishing (Buffer/Instagram/Threads/Meta), lead import/export, contact merge/timeline, global search, automations, referrals. The failure mode is not "I can't do that" — it is the model improvising a plausible answer.

**Do not** attempt this before Phase 0 and 1 are merged. It touches the same files.

---

## Packet 2.1 — Registry core (Tier A)

**Contract.** One declaration per platform capability. Chat tools, MCP `tools/list`, the approval gate, and the audit log all derive from it. Adding a feature means adding one registry entry.

**Files:** `lib/capabilities/types.ts`, `lib/capabilities/registry.ts` (new), `lib/agent/tools.ts` (becomes an adapter).

```ts
// lib/capabilities/types.ts
export type GateClass =
  | 'read'            // no mutation. auto-run.
  | 'internal_write'  // mutates only LeadRail state. auto-run.
  | 'spend'           // consumes credits or ad budget. approval required.
  | 'external_send'   // reaches a real third party. approval required.
  | 'destructive';    // irreversible deletion. approval required.

export interface Capability {
  name: string;                 // stable id, camelCase. NEVER renamed once shipped.
  domain: string;               // 'leads' | 'campaigns' | 'journeys' | ...
  title: string;                // human title for approval cards
  description: string;          // plain-language, written FOR the model
  gate: GateClass;
  inputSchema: Record<string, any>;
  zod: z.ZodTypeAny;
  run: (accountId: string, args: any) => Promise<any>;
  /** Optional: derive truthful per-run metrics from a real result. */
  metrics?: (args: any, result: any) => Record<string, number>;
  /** Optional: one-sentence approval summary. Falls back to title + args. */
  summarize?: (args: any) => string;
}
export const SENSITIVE_GATES: GateClass[] = ['spend', 'external_send', 'destructive'];
export const isSensitive = (c: Capability) => SENSITIVE_GATES.includes(c.gate);
```

**Migration path — additive, not a rewrite.** `lib/agent/tools.ts` keeps exporting `TOOLS`, `runTool`, `toolSpecs`, `toolCatalogForPrompt` with **identical signatures**, but builds them from the registry:
```ts
export const TOOLS: Record<string, AgentTool> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, {
    title: c.title, description: c.description, inputSchema: c.inputSchema,
    zod: c.zod, sensitive: isSensitive(c), run: c.run,
  }]),
);
```
Nothing downstream changes. `deriveMetrics` in `loop.ts` moves onto the capability's `metrics` fn and the switch statement is deleted.

**Step 1 is a pure port:** move all 35 existing tools into `lib/capabilities/<domain>.ts` files, assigning each a `gate` that reproduces today's `sensitive` flag exactly. `launchCampaign`→`spend`, `sourceLeads`/`enrichLead`→`spend`, `sendEmail`/`enrollInSequence`→`external_send`, everything else→`read`/`internal_write`. **Zero behaviour change is the acceptance criterion for 2.1.** Verify by diffing `toolCatalogForPrompt()` output before and after — it must be byte-identical modulo ordering.

**Acceptance criteria:** `toolSpecs()` returns the same 35 tools; the agent loop file has no `deriveMetrics` switch; `npm run build` passes; no route file changed.

---

## Packet 2.2 — Backfill the missing surface (Tier B, parallelisable)

Once 2.1 is merged, each domain is an **independent packet** — hand them to separate executor runs. Every capability is a thin wrapper over the existing service function; **no business logic is reimplemented** (this is already the stated rule at the top of `lib/agent/tools.ts` — keep it).

Priority order by user value:

| # | Domain | File | Backing service | Capabilities | Gates |
|---|---|---|---|---|---|
| 1 | pipeline/deals | `capabilities/deals.ts` | `lib/crm.ts`, `lib/pipeline/store.ts` | listDeals, getDeal, updateDeal, deleteDeal, listActivities, logActivity | read / internal_write / destructive |
| 2 | segments | `capabilities/segments.ts` | `lib/segments/store.ts` | listSegments, previewSegment, createSegment, updateSegment | read / internal_write |
| 3 | journeys | `capabilities/journeys.ts` | `lib/journeys/store.ts` | listJourneys, getJourney, createJourney, enrollInJourney, pauseJourney | enroll = external_send |
| 4 | content | `capabilities/content.ts` | `lib/pipeline/store.ts`, `app/api/content` | listContent, createContent, updateContent, **publishContent** | publish = external_send |
| 5 | social | `capabilities/social.ts` | `lib/social/*` | listChannels, schedulePost, publishPost, listPostMetrics | publish/schedule = external_send |
| 6 | inbox | `capabilities/inbox.ts` | `lib/inbox/*`, `lib/conversations.ts` | getThread, **replyToThread**, markRead | reply = external_send |
| 7 | companies | `capabilities/companies.ts` | `app/api/companies`, `lib/crm.ts` | listCompanies, getCompany, createCompany, linkContactToCompany | read / internal_write |
| 8 | analytics | `capabilities/analytics.ts` | `lib/analytics/store.ts` | getOverview, getCampaignAnalytics, getSequenceStats | read |
| 9 | forms | `capabilities/forms.ts` | `lib/forms/store.ts` | listForms, getForm, listSubmissions, createForm | read / internal_write |
| 10 | budgets | `capabilities/budgets.ts` | `lib/budgets/store.ts` | listBudgets, getBudgetStatus, setBudget | read / internal_write |
| 11 | scheduled | `capabilities/scheduled.ts` | `lib/scheduled/store.ts` | listScheduledTasks, createScheduledTask, disableScheduledTask | internal_write |
| 12 | templates/ICP | `capabilities/templates.ts` | `lib/templates`, `lib/icp.ts` | listTemplates, getTemplate, createTemplate, getIcp, updateIcp | read / internal_write |
| 13 | search | `capabilities/search.ts` | `lib/search.ts` | globalSearch | read |
| 14 | suppressions | `capabilities/suppressions.ts` | `lib/suppressions.ts` | listSuppressions, addSuppression | internal_write |
| 15 | leads bulk | `capabilities/leads-bulk.ts` | `app/api/leads/import`, `/export`, `/enrich/bulk` | importLeads, exportLeads, **bulkEnrich** | bulkEnrich = spend |

**Per-domain packet template** (fill in and hand to an executor):
```
Implement lib/capabilities/<domain>.ts exporting `export const <DOMAIN>_CAPABILITIES: Capability[]`.
- Import the backing service functions listed. Do NOT write new queries against supabase
  directly if a service fn already exists.
- Every run(accountId, args) MUST pass accountId through to the service fn. If a service fn
  does not accept an account scope, STOP and report it — do not work around it.
- Descriptions are written for a model, not a developer: say what it does and when to use it,
  in plain language, no internal vendor names.
- Register the array in lib/capabilities/registry.ts.
- Add the domain's tools to TOOL_VERB in src/components/AgentConsole.tsx.
Acceptance: toolSpecs() includes the new names; npx tsc --noEmit && npm run build pass.
```

**Hard rule for reviewers:** any capability whose backing service function lacks an `accountId` parameter is a **tenant-isolation bug in that service**, not something the capability layer should paper over. Two known instances to check: `listSequences(brandId)` and `enrollContacts(sequenceId, accountId, contactIds)` take different scope shapes — normalise before wrapping.

---

## Packet 2.3 — API=MCP parity test (the pendpost pattern)

`OSS_INTEGRATION_PLAN.md` §2b flags pendpost's parity-check pattern as something to adopt; it was never built. Build it now — it is what stops the registry drifting.

**File:** `tests/parity.test.ts` (or `scripts/parity-check.ts` if the e2e harness isn't wired).

Assertions:
1. Every `Capability.name` is unique and camelCase.
2. Every capability's `zod` schema and `inputSchema` agree on required keys (parse a generated fixture through both).
3. Every capability with gate in `SENSITIVE_GATES` produces `sensitive: true` in the derived `TOOLS` map.
4. Every capability appears in `toolSpecs()` (MCP) and in `toolCatalogForPrompt()` (chat) — the two front doors cannot diverge.
5. Every tool name in `TOOL_VERB` exists in the registry, and vice versa.

Wire into CI / the build script. This test failing is the signal that someone added a feature without its capability.

---

# PHASE 3 — Ground the background agents

**Problem.** Two callers run the agent with no context at all:
- `lib/scheduled/store.ts:146` → `runAgent({ accountId, message: task.prompt })`
- `lib/pipeline/store.ts:198` → `runAgent({ accountId, message: instruction })`

Neither passes `agentContext`, `brandContext`, or a persona. So background runs get none of the platform brief, venture profile, account snapshot, or durable memory the chat path gets — the same model, materially dumber, on the runs nobody is watching.

**Worse:** `runAgent` returns `status:'needs_approval'` as a *value*, not an exception. `runDueScheduledTasks` has no branch for it, so the task records `last_status:'ok'` with the proposal summary as its result. **A scheduled task that hit a sensitive tool silently did nothing and reported success.**

## Packet 3.1 (Tier A — correctness-critical)

**Files:** `lib/scheduled/store.ts`, `lib/pipeline/store.ts`, `migrations/040_scheduled_brand.sql`.

1. Migration: `ALTER TABLE scheduled_tasks ADD COLUMN IF NOT EXISTS brand_id UUID;` and same for the pipeline table if it lacks one.
2. Both call sites: build context first —
   ```ts
   const agentContext = await loadAgentContext({ accountId: task.account_id, brandId: task.brand_id ?? undefined, query: task.prompt });
   const result = await runAgent({ accountId: task.account_id, brandId..., message: task.prompt, agentContext });
   ```
3. Handle all three statuses explicitly in `runDueScheduledTasks`:
   - `done` → `last_status:'ok'`
   - `needs_approval` → `last_status:'needs_approval'`, persist the `approvals` row id in `last_result`, and **create a notification** via `lib/notifications/store.ts` so a human is told. Update the state CHECK constraint to allow the new value.
   - `error` → `last_status:'error'` (existing path)
4. Same three-way handling in `lib/pipeline/store.ts` — a pipeline stage that needs approval must halt the pipeline, not silently continue to the next stage with a missing artifact.

**Acceptance criteria:** a scheduled task whose prompt triggers `sendEmail` records `needs_approval`, creates a notification, and does not report ok. A scheduled task run produces the same grounding block as an equivalent chat message (compare `loadAgentContext` output).

---

# PHASE 4 — Bridge external MCP clients into the agent

**Problem.** `lib/mcp/client.ts` connects to external MCP servers. `lib/mcp/clients.ts` has full encrypted CRUD. `app/api/mcp-clients/[id]/test` verifies a connection. `src/components/McpClients.tsx` is a working settings UI. And **the agent cannot call a single tool from any of it** — there is no bridge from a connected MCP server into `TOOLS`. A user can connect a server, see its tools listed, and the assistant remains unaware they exist.

**Contract.** Tools from connected MCP clients appear in the agent's catalog namespaced by client, are called through the existing connector, and are gated conservatively.

**Files:** `lib/capabilities/external-mcp.ts` (new), `lib/agent/loop.ts` (catalog assembly), `lib/mcp/clients.ts` (add a cached tool-list read).

**Steps**

1. Cache the tool list per client. Add `tools_cache JSONB` + `tools_cached_at TIMESTAMPTZ` to `mcp_clients` (migration 041). Populate on the existing `/test` call and refresh lazily when older than 15 minutes. **Do not** connect to remote servers inside the agent loop's hot path — a slow third-party server would stall every turn.
2. `loadExternalCapabilities(accountId): Promise<Capability[]>` — for each enabled client, map each cached tool to a Capability with:
   - `name`: `ext_<clientSlug>_<toolName>` (namespaced; prevents collision with first-party names)
   - `domain`: `'external'`
   - `gate`: **`external_send` by default.** A third-party tool's side effects are unknown; treat every one as approval-required unless the operator explicitly marks that client's tools as safe (`allow_auto BOOLEAN` on the client row, default false).
   - `run`: connect via `lib/mcp/client.ts` using the decrypted auth header, call `tools/call`, return the result.
3. `lib/agent/loop.ts`: `systemPrompt()` currently calls `toolCatalogForPrompt()` with no account. Change to `toolCatalogForPrompt(externalCaps)` and assemble per-turn: `const caps = [...CAPABILITIES, ...await loadExternalCapabilities(accountId)]`. `runTool` needs the same list — thread it through rather than reading the module-level map.
4. Cap external tools at 25 per account in the prompt (catalog bloat degrades routing accuracy); if a client exposes more, include the first 25 and note the truncation.
5. Failure isolation: an unreachable MCP client must never break a turn. Wrap every external call in try/catch returning `ERROR: <client> is unavailable` as a normal observation.

**Acceptance criteria:** connect an external MCP server in settings → its tools appear in the agent catalog → calling one produces an approval prompt → approving executes it and returns the result as an observation. Disconnecting the server mid-chat degrades to an error observation, not a failed turn.

**Reviewer checklist** — confirm no remote network call happens synchronously during `systemPrompt()` assembly on a cache hit; confirm default gate is approval-required; confirm auth headers are decrypted server-side only and never logged.

---

# PHASE 5 — Finish the skills harvest

**Problem.** `OSS_INTEGRATION_PLAN.md` §2d targets **~350+ skills** across four permissively-licensed sources and calls it "HIGHEST ROI, do first." `lib/skills/harvested.ts` contains **121 skills, all from adclaw**. Roughly two-thirds of the phase never ran:

| Source | License | Planned | In repo |
|---|---|---|---|
| adclaw | Apache-2.0 | 125 | **121** ✅ |
| digital-marketing-pro | MIT | 163 skills + 24 agent roles | **0** ❌ |
| kai-cmo-harness | MIT subset | 57 skills + 67 playbooks + 37 checklists + 38 frameworks | **0** ❌ |
| marketing-os-starter | MIT | 6 hook formulas + 7 growth playbooks | **0** ❌ |

**Blocker:** the clones lived at `/home/.z/workspaces/con_rf0cG0dud6GVzG4C/oss-repos/` and **are not on this machine**. `scripts/harvest-skills.ts` cannot run until they are re-cloned.

## Packet 5.1 — Re-clone and re-run (Tier C, bulk)

1. Re-clone the three missing repos **outside the LeadRail git tree** (the licensing-contamination precaution in §Licensing is correct — keep it). Suggested: `~/Desktop/oss-repos/`. Add that path to `.gitignore` defensively if it ever lands inside.
2. Re-read `scripts/harvest-skills.ts` — it is currently adclaw-specific (frontmatter schema, path glob). Generalise it to a `SOURCES` array of `{ name, license, glob, frontmatterMap }` so each source normalises into the same `HarvestedSkill` shape.
3. Verify the license gate **per file, not per repo**: kai-cmo-harness is MIT only in `harness/skills/`, `knowledge/`, `scripts/quality_gates/` — `app-meetkai/`, `daemon/`, `agent/`, `gateway/`, `kai/` are Elastic-2.0 and must be excluded by path. Encode this as an explicit deny-list in the script, not a comment.
4. De-dupe across sources by normalised slug; on collision prefer the more specific/longer instruction body and record both in `inspiredBy`.
5. Produce/refresh a `NOTICE` file at repo root with Apache-2.0 attribution for adclaw (required by the license) and MIT attribution for the rest. **This is currently missing and is a compliance gap.**

**Acceptance criteria:** `lib/skills/harvested.ts` regenerates with 300+ entries across 4 distinct `source` values; `grep -o '"license": "[^"]*"' | sort -u` returns only `Apache-2.0` and `MIT`; a `NOTICE` file exists; no file under an Elastic-2.0 path was read.

**Reviewer checklist (Opus, non-negotiable)** — spot-check 10 harvested entries against their source paths to confirm the license attribution is correct. A mislabeled AGPL or Elastic-2.0 skill in a commercial product is the single most expensive error in this plan.

## Packet 5.2 — Agent roles → personas

digital-marketing-pro ships 24 agent role definitions; adclaw ships a persona/coordinator model. `lib/agent/personas.ts` already implements the persona row + coordinator. Seed the 24 roles as **optional, disabled-by-default** persona templates an account can adopt (mirror the `account_skills` opt-in pattern in `lib/skills/store.ts` — a template affects nothing until explicitly enabled).

---

# PHASE 6 — Persona coordinator synthesis

**Problem.** `lib/agent/loop.ts` `resolvePersonaForTurn` carries an honest TODO: when several personas are @mentioned, a full implementation would run each persona's instructions independently and merge the outputs. That fan-out "doesn't fit safely inside the existing single-transcript ReAct loop without risking MAX_STEPS/token regressions," so today the coordinator merely *frames* one reply. Also: `personaId` is accepted by both agent routes but `AgentConsole` never sends it — only @mention routing works, and there is no persona picker.

This is the lowest-priority phase. It is a capability upgrade, not a defect. Do it last.

## Packet 6.1 — Persona picker (Tier C, trivial)

`AgentConsole.tsx`: fetch `GET /api/personas`, render pill-tabs above the composer (this is the adclaw console pattern named in `OSS_INTEGRATION_PLAN.md` §2a), send the selected `personaId` in the request body. The server side already works — this is UI only.

## Packet 6.2 — True fan-out (Tier A, design carefully)

Do **not** put the fan-out inside the ReAct loop — the TODO's reasoning is correct. Instead:

1. New `lib/agent/coordinator.ts`. When `resolveMentionedPersonas` returns >1 and a coordinator exists, the *route* (not the loop) takes a separate path.
2. Run each mentioned persona as an independent `runAgent` call with `MAX_STEPS` reduced to 4 and a shared read-only context, **in parallel** (`Promise.allSettled`). Each returns a final message.
3. Feed the collected outputs to the coordinator persona as a single synthesis call — `generateChat` with a system prompt built from `buildCoordinatorSystemBlock` plus the labelled per-persona answers. One unified reply.
4. Hard limits: max 3 personas fanned out (beyond that, ask the user to narrow); any persona that errors is reported as "X couldn't weigh in" rather than failing the turn.
5. **Sensitive tools during fan-out:** a delegated persona that proposes a sensitive tool must abort *its own* branch and surface the proposal to the coordinator, which reports it. Do not let three parallel branches each raise approvals for the same action.
6. SSE: emit `thought` events prefixed with the persona name so the user sees who is working.

**Acceptance criteria:** `@researcher @copywriter draft an outreach angle for X` produces one coherent answer that visibly draws on both; token usage stays bounded; no duplicate approval rows.

---

# Sequencing & dependencies

```
0.1 ──┐
0.2 ──┼─→ 1.2 ─→ 1.3
0.3 ──┘
1.1 ──────────────┐
                  ├─→ 2.1 ─→ 2.2 (parallel by domain) ─→ 2.3
                  │
3.1 ───────────────┘        (3.1 can run alongside 2.x; it only touches store files)
2.1 ─→ 4 (bridge needs the Capability type)
5.1 ─→ 5.2                  (independent of everything else — can run any time)
2.x ─→ 6.1 ─→ 6.2           (do last)
```

**Critical path:** 0.1 → 0.2 → 2.1 → 2.2. Everything else is parallelisable.

**Recommended first sprint:** 0.1, 0.2, 0.3, 1.1, 1.2, 1.3. That is the whole security surface plus every dead feature turned on, and it is achievable without touching the tool registry.

---

# Review protocol

Every returned diff gets checked against these before merge. This list is the reviewer's job, not the executor's.

**Always:**
1. Does every new DB query filter by `account_id` **in the query**, not after fetching?
2. Did anything client-supplied become authoritative (account, approval state, transcript, persona ownership)?
3. Are there new `catch {}` blocks that swallow an error which should fail the operation? (The codebase uses silent-catch deliberately for *best-effort* writes — memory, logging, persistence. It must never be used for a *gate*.)
4. Were files outside the packet's "Files" list touched?
5. Does the comment style match — does it explain WHY, and mark additive changes as additive?
6. Do `runAgent` and `runAgentStream` still behave identically?

**Phase 0 additionally:** trace by hand every path that reaches `runTool` for a sensitive capability and confirm each passes through `consumeApprovalForExecution`.

**Phase 5 additionally:** license attribution spot-check (see 5.1).

---

# Known open decisions (need the operator, not an executor)

1. **`pauseCampaign` gate** — recommended: stays non-sensitive (it stops spend). Confirm.
2. **Legacy `APP_API_SECRET`** — recommended: keep it working but force `allow_sensitive=false`. Alternative is a hard cutover to `mcp_api_keys`, which breaks any existing integration. Confirm.
3. **External MCP default gate** — recommended: approval-required for all third-party tools. Loosening this per-client is an operator decision with real blast radius.
4. **Passive memory extraction** — recommended: on compaction only. Per-turn extraction is noisier and burns embedding calls; per-conversation-end is unreliable because chats are rarely "ended."
5. **Where the re-cloned OSS repos live** — must stay outside the git tree. Confirm the path.

---

# PHASE 7 — Social platform completion

Added 2026-08-16. Scope confirmed by the operator: the assistant gets the **full Meta scope** — posting, comments, message responses, automations, read + write, and ads — across **facebook, instagram, threads, linkedin, tiktok, x**.

**Reality check before planning.** Only three of those six are connectable today:

| Platform | `providers.ts` | OAuth routes | Env keys | Publisher |
|---|---|---|---|---|
| facebook | `live: true` | ✅ `/api/social/meta/{connect,callback}` | ✅ | ✅ `publishToFacebookPage` |
| instagram | `live: true` | ✅ `/api/social/instagram/{connect,callback}` | ✅ | ✅ `publishToInstagramForAccount` |
| threads | `live: true` | ✅ `/api/social/threads/{connect,callback}` | ⚠ partial | ❌ none |
| linkedin | `live: false` | ❌ | ❌ | ❌ |
| tiktok | `live: false` | ❌ | ❌ | ❌ |
| x | `live: false` | ❌ | ❌ | ❌ |

`lib/social/providers.ts` says as much in its own comment: platforms marked `live: false` are "scaffolded in the backend now; their OAuth + UI ship later." The Connections UI renders a card for all six because it maps `SOCIAL_PROVIDERS`, which makes them *look* available. **They are not.** Anyone reading the UI would reasonably believe otherwise — worth fixing the card state in 7.1 too.

**Design consequence, already encoded in `delegation/PACKET-2.2-S-social.md`:** capabilities are registry-driven. Platform validity is read from `LIVE_SOCIALS` at call time and publishing goes through a `PUBLISHERS` map. Flipping a platform to `live: true` plus adding one map entry is the entire integration cost on the agent side. **Do not hardcode platform lists anywhere.**

---

## Packet 7.1 — OAuth for LinkedIn, TikTok, X (Tier A, one packet per platform)

Run these as **three independent packets** — they share a shape but nothing else, and each has its own review/approval quirks.

Follow the existing pattern exactly; `lib/social/threads-oauth.ts` + `app/api/social/threads/{connect,callback}` is the cleanest template (newest, smallest).

Per platform:
1. `lib/social/<platform>-oauth.ts` mirroring `threads-oauth.ts`: `<p>Configured()`, `redirectUri()`, `buildAuthorizeUrl(state)`, `exchange<P>Code(code)`, `getLongLived<P>Token(short)`, `get<P>Profile(token)`. Reuse `signState`/`verifyState` from `meta-oauth.ts` — do not reimplement CSRF state.
2. `app/api/social/<platform>/connect/route.ts` + `callback/route.ts`, mirroring the Threads pair.
3. Callback upserts into `integration_connections` with `provider = '<platform>'`, `external_id` = the platform account id, plus `display_name` / `username`. The `(account_id, provider, external_id)` unique constraint gives multi-account for free — **do not** collapse to one row per platform.
4. `.env.local.example` — add the client id/secret pair. Never commit real values.
5. Flip `live: true` in `providers.ts` and set `connectPath` **only when 1–4 are done and tested**. That flag is what exposes the platform to the agent.

**Platform-specific gotchas the executor must handle, not discover:**
- **LinkedIn** — posting needs `w_member_social`; company-page posting needs an Organization ACL and a separate `author` URN (`urn:li:organization:<id>` vs `urn:li:person:<id>`). Tokens are 60-day and **not silently refreshable** — store `expires_at` and surface expiry, don't let posts fail mysteriously.
- **TikTok** — Content Posting API requires app audit before `DIRECT_POST` is allowed; unaudited apps can only push to drafts. Domain verification is required for media URLs. Build the draft path first.
- **X** — v2 posting requires a paid tier; free tier is read-limited. Confirm the account's plan before building the publisher, or `publishSocialPost` will fail at runtime for reasons no error message will explain.

**Acceptance:** a user can connect the platform from Connections, a row lands in `integration_connections` with a real `external_id`, `listSocialAccounts` returns it with no capability code change, and disconnect works.

## Packet 7.1b — Fix the misleading Connections UI (Tier C, do first, tiny)

Cards for `live: false` platforms currently look connectable. Render them visibly as "Coming soon" / disabled with no connect action. This is a five-line change and it stops users (and the assistant's own grounding) believing in integrations that don't exist.

## Packet 7.2 — Per-account credentials for Buffer / GHL (Tier A)

`lib/social/buffer.ts` and `lib/social/ghl.ts` read `BUFFER_API_KEY` / `GOHIGHLEVEL_ACCESS_TOKEN` from the environment. Every tenant shares one credential. Packet 2.2-S guards around this; **this packet removes the cause.**

Move both to `integration_connections` rows with the token in an encrypted column, using the exact pattern already proven in `lib/mcp/clients.ts` (`auth_header_encrypted` + `lib/ai/crypto.ts` `encryptSecret`/`decryptSecret`). Change the service signatures to `(accountId, …)` and resolve credentials per call. Keep the env var as a fallback **only** when zero connection rows exist, so single-tenant owner setups keep working.

## Packet 7.3 — Automation runner (Tier A — do LAST, after 2.2-S)

Packet 2.2-S creates the `social_automations` table and its management capabilities but deliberately **does not execute anything**. This packet builds the runner.

1. Trigger from the existing inbound webhooks (`app/api/webhooks/meta`, and `lib/social/meta-engagement.ts` for comments) — not a polling loop.
2. On each inbound event: match enabled rules for that `(account_id, platform, external_id)`, evaluate `match`, and execute `action`.
3. **Enforce `daily_cap` at send time.** Reset `sends_today` on date rollover; at the cap, stop and raise a notification via `lib/notifications/store.ts`. The DB CHECK (`daily_cap <= 200`) is the ceiling; the runner is what actually honours it.
4. Every automated send writes an `approvals` row in state `executed` with `requested_by = 'automation:<rule_id>'`, so automated sends appear in the same audit trail as human-approved ones. **An automated send that leaves no trace is unacceptable.**
5. Never auto-reply to an auto-reply: ignore events whose author is one of the account's own connected `external_id`s. Loop protection is not optional.
6. Kill switch: one account-level flag that disables every automation at once, exposed in settings.

**Reviewer note:** this is the highest-blast-radius packet in the whole plan — it is the only place where the platform sends messages to real people with no human in the loop. Review the cap enforcement, the loop guard, and the kill switch line by line before merging.

---

## Updated sequencing

```
2.1 ─→ 2.2-S (social capabilities, registry-driven)
              ├─→ 7.3 (automation runner — LAST)
7.1b (UI fix, standalone, do anytime)
7.1 (LinkedIn | TikTok | X — three parallel packets, independent of 2.x)
7.2 (Buffer/GHL per-account creds — independent)
```

7.1 and 2.2-S do not block each other: 2.2-S is written so new platforms need no capability changes. That is the whole point of the registry-driven design — **verify it in review by flipping a `live` flag locally and confirming nothing else needs to change.**
