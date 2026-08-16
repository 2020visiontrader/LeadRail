# PACKET 8.1 — Split the loop: route ≠ compose

**Tier:** A · **Branch:** `feat/copilot-remediation` · **Depends on:** 2.1 merged.

---

## The problem

`lib/agent/loop.ts` uses ONE model call shape for two jobs that want opposite settings. Every call — tool routing *and* the user-facing answer — runs at:

- `maxOutputTokens: 700` → substantive answers are truncated by construction
- `temperature: 0.2` → correct for JSON routing, flat for prose
- pinned fast tier (`AGENT_ZOASK_MODEL`, Haiku-class) chosen for routing latency → the cheapest model in the ladder writes the long-form replies
- output wrapped in `{"action":"final","message":"..."}` → prose is escaped into a JSON string, so markdown, newlines, lists and structure get flattened

Net effect: the assistant reasons acceptably and writes badly. The fix is to stop asking one call to do both.

## The architecture

```
user input
   ↓
ROUTE pass    fast tier · temp 0.2 · 700 tok · JSON envelope · tools
   ↓          (unchanged — this part works)
   ↓ loop until the model emits action:"final"
   ↓
COMPOSE pass  heavy tier · temp 0.6 · 2000 tok · PLAIN TEXT · no tools
   ↓          sees: user's question + everything the route pass gathered
final answer
```

The route pass keeps deciding *what to do*. A second pass decides *how to say it*, with a model and settings suited to writing. `action:"final"`'s `message` becomes a **draft/intent**, not the shipped answer.

---

## Files

**Create:** `lib/agent/compose.ts`
**Modify:** `lib/ai/providers.ts`, `lib/ai/router.ts`, `lib/agent/loop.ts`

---

## Step 1 — Task-aware model routing (`lib/ai/providers.ts`)

`ai_models` already has `tier` (`fast|balanced|heavy`) and `good TEXT[]`, and `lib/ai/models.ts` defines `TaskKind = classify | draft | reason | extract | code | long`. **`resolveChain` never reads `good`.** Task-aware routing is fully specified in the schema and entirely unwired. Wire it.

Add, next to `resolveChain` and reusing its loading logic (do not duplicate the queries — factor a private helper if needed):

```ts
/** Resolve a chain PREFERRING models tagged for `task`, then the account's
 *  normal active/fallback order. Never returns fewer models than resolveChain —
 *  task tags reorder, they never exclude, so a mis-tagged roster degrades to
 *  today's behaviour instead of failing to answer. */
export async function resolveChainForTask(
  accountId: string,
  task: string,
  opts?: { preferTier?: 'fast' | 'balanced' | 'heavy' },
): Promise<ResolvedModel[]>
```

Ordering: models whose `good` includes `task` AND (no `preferTier`, or `tier === preferTier`) first; then remaining `good`-matching; then the untouched `resolveChain` order. De-dupe by model id, preserve first occurrence. Skip disabled models/providers and any provider whose `account_id !== accountId`, exactly as `resolveChain` does.

## Step 2 — `generateChat` accepts a task hint (`lib/ai/router.ts`)

Add two optional fields to `generateChat`'s options: `task?: string` and `preferTier?: 'fast'|'balanced'|'heavy'`. When `accountId` is set AND the registry is configured AND `task` is present, `tryRegistry` uses `resolveChainForTask(accountId, task, { preferTier })` instead of `resolveChain`.

**Everything else is unchanged.** With no `task`, or no registry, behaviour is byte-identical to today — the hardcoded Zo Ask → OpenCode → NIM ladder still applies. This must remain a pure addition.

## Step 3 — `lib/agent/compose.ts`

```ts
export interface ComposeInput {
  accountId: string;
  /** The user's most recent instruction. */
  userMessage?: string;
  /** The route pass's own draft (parsed.message from action:"final"). */
  draft: string;
  /** The route pass transcript — carries OBSERVATION lines with real data. */
  transcript: ChatMessage[];
  /** Grounding block already assembled by loadAgentContext. */
  agentContext?: string;
  /** Persona system block, when one is active. */
  personaBlock?: string;
}

/** Rewrite the route pass's draft into the answer the user actually reads.
 *  Falls back to the draft verbatim on ANY failure — a compose outage must
 *  degrade to today's output, never to an error. */
export async function composeAnswer(input: ComposeInput): Promise<string>
```

System prompt requirements — this is the part that determines whether it feels right:

- Write as the operator copilot: warm, direct, plain language, no filler preamble.
- **Ground every factual claim in the OBSERVATION lines.** Never invent numbers, leads, campaigns, or statuses. If the data isn't there, say what's missing.
- Use markdown naturally — short paragraphs, lists only when the content is genuinely a list, a table when comparing.
- Lead with the answer. No "Great question!", no restating the request, no summary of what you just did unless asked.
- Never mention tools, internal names, vendors, model names, or the two-pass architecture.
- Match length to the question: one line for a one-line answer, more when it earns it.
- **Output plain text only. No JSON, no wrapper object.**

Call settings: `temperature: 0.6`, `maxOutputTokens: 2000`, `task: 'draft'`, `preferTier: 'heavy'`.

Include in the user turn: the user's question, the draft, and the OBSERVATION lines pulled from the transcript (cap the observation block at ~6000 chars, newest first, so a long run can't blow the budget).

**Fallback is mandatory:** wrap in try/catch, and on any error or an empty result return `input.draft` unchanged.

## Step 4 — Wire into `lib/agent/loop.ts`

At BOTH `action === 'final'` branches (`runAgent` and `runAgentStream`), replace the direct use of `parsed.message` with a compose call. In `runAgentStream`, emit a `composing` event first so the UI can show a step while it runs:

```ts
if (parsed.action === 'final') {
  const draft = String(parsed.message || '').trim() || 'Done.';
  emit({ type: 'thought', text: 'Writing up the answer…' });
  const message = await composeAnswer({
    accountId, userMessage: input.message, draft, transcript: messages,
    agentContext: input.agentContext, personaBlock,
  });
  ...
}
```

Add an env kill switch: `AGENT_COMPOSE = process.env.AGENT_COMPOSE !== '0'`. When off, use `draft` directly — one env var reverts to today's behaviour.

**Do not touch the route pass's own settings.** `temperature: 0.2`, `maxOutputTokens: 700`, and the JSON protocol stay exactly as they are — they are correct for routing, and changing them would regress tool selection.

---

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` passes.
2. With no provider registry configured, `resolveChainForTask` and `resolveChain` return identical results (task tags reorder, never exclude).
3. `AGENT_COMPOSE=0` reproduces today's output exactly.
4. A compose failure returns the draft, never an error to the user.
5. The route pass still runs at temp 0.2 / 700 tokens with the JSON protocol.
6. `composeAnswer` never receives or calls tools.
7. `toolCatalogForPrompt()` output is unchanged (no capability touched).

## Reviewer checklist (human — do not self-certify)

- [ ] Compose cannot fabricate: the prompt forbids invented data and the observation block is the only factual source.
- [ ] Fallback to draft is genuinely unconditional (catch-all, plus empty-result check).
- [ ] No secrets or tokens reach the compose prompt via the transcript.
- [ ] Route-pass settings untouched — diff `temperature: 0.2` and `maxOutputTokens: 700` call sites.
- [ ] `resolveChainForTask` filters by `account_id` in-query like `resolveChain`.
