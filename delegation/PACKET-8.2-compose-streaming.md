# PACKET 8.2 — Stream the compose pass

**Tier:** B · **Branch:** `feat/copilot-remediation` · **Depends on:** 8.1 + 8.1b merged.

*Written retroactively from the shipped diff, so the queue keeps a spec per packet.*

---

## The problem

Packet 8.1 moved the user-facing answer into a second compose pass with a heavier
model and a larger budget. That made the prose better and the wait longer: the
whole answer is buffered, then delivered in one `final` event. The user watches a
spinner through the slowest call in the turn.

## The architecture

```
compose pass
   ↓ token deltas
streamChat (lib/ai/router.ts)   same tiers, same order, same fall-through
   ↓
composeAnswer(input, onDelta?)  onDelta optional — omitted = today's path
   ↓
runAgentStream → emit final_delta
   ↓
SSE → AgentConsole appends
   ↓
final event OVERWRITES with the authoritative message
```

**Deltas are a progressive preview, never the truth.** A tier can emit tokens and
then fail, at which point the ladder falls through and what the user has seen is
stale. Un-emitting is impossible on a live stream, so the contract runs the other
way: `final.message` is authoritative and the client overwrites whatever it
accumulated. This is also what makes a mid-stream compose failure — which returns
the route pass's draft — render correctly.

---

## Files

**Modify:** `lib/ai/router.ts`, `lib/ai/providers.ts`, `lib/ai/opencode.ts`,
`lib/ai/nim.ts`, `lib/agent/compose.ts`, `lib/agent/loop.ts`,
`app/api/agent/stream/route.ts`, `src/components/AgentConsole.tsx`

The four AI transport files are wider than 8.1's list. This was deliberate and is
recorded here rather than buried: provider keys are module-private, so a streaming
transport cannot live in `router.ts` alone. Every addition is purely additive —
`generateChat` and `callModel` are untouched.

## Step 1 — `streamChat` (`lib/ai/router.ts`)

```ts
export async function streamChat(
  opts: Parameters<typeof generateChat>[0],
  onDelta: (chunk: string) => void,
): Promise<string>
```

Resolves with the COMPLETE text, exactly as `generateChat` would. Same layers in
the same order — registry chain via the shared `tryRegistry` helper (honouring
`task`/`preferTier`), then the hardcoded Zo Ask → OpenCode → NIM ladder. A failing
tier falls through; if every tier fails, the last error is thrown.

Tiers with no streaming transport (Zo Ask, Gemini) call the existing buffered path
and invoke `onDelta` exactly once with the whole answer. The caller must not have
to know which happened.

## Step 2 — `callModelStream` (`lib/ai/providers.ts`)

Same budget resolution as `callModel` (`resolveMaxOutputTokens`). Real SSE for
`openai-compatible` / `custom` (`choices[0].delta.content`) and `anthropic`
(`content_block_delta` → `delta.text`). Delegates to the opencode/nim streaming
variants. Everything else falls back to buffered `callModel` + one delta. Reuses
`decryptProviderKey` and the existing error shapes verbatim.

## Step 3 — transports (`lib/ai/opencode.ts`, `lib/ai/nim.ts`)

Exported `streamChat` / `nimStreamChat` mirroring the existing chat options and
error handling. `readSseDeltas` — the shared `data:` line reader — lives in
`opencode.ts`, a dependency-free leaf that both `router.ts` and `providers.ts`
already import. Hosting it in `router.ts` would make `providers.ts` import
`router.ts`, which `router.ts` already imports.

OpenCode's DeepSeek `thinking: {type:'disabled'}` rule is preserved. Its
empty-content self-heal retry is deliberately NOT reproduced: re-running a call
that has already emitted deltas would duplicate visible output. An empty stream
throws the `upstream` shape so the router falls to the next tier.

## Step 4 — `composeAnswer(input, onDelta?)` (`lib/agent/compose.ts`)

With no `onDelta`, byte-identical to 8.1. With one, calls `streamChat` using the
same settings and the same prompt text. The mandatory draft fallback is unchanged:
try/catch plus the empty-result check, with streaming errors landing in that catch.

Second kill switch: `AGENT_COMPOSE_STREAM=0` keeps compose but takes the buffered
path.

## Step 5 — `lib/agent/loop.ts`

`| { type: 'final_delta'; text: string }` added to `AgentEvent`. Wired in
`runAgentStream`'s `action === 'final'` branch only. `runAgent` still calls
`composeAnswer(input)` with one argument. The `final` event still carries the
complete message, transcript, and token estimate.

## Step 6 — client

`final_delta` passes through the stream route untouched (only `final` /
`needs_approval` capture the transcript). `AgentConsole` appends deltas and
returns BEFORE the pending-step resolution, so the "Writing up the answer…" step
keeps spinning until `final` arrives and overwrites the text.

---

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` passes. ✅
2. `npm run build` passes. ✅
3. `AGENT_COMPOSE=0` reproduces today's output exactly — no compose, no deltas. ✅
4. `AGENT_COMPOSE_STREAM=0` keeps compose on the buffered path. ✅
5. A compose failure returns the draft, never an error to the user. ✅
6. `generateChat` and `callModel` are behaviourally untouched. ✅
7. Route pass still runs at temp 0.2 / 700 tokens with the JSON protocol. ✅
8. `runAgent` (non-streaming) output is unchanged. ✅
9. No secrets reach any prompt or any SSE event. ✅

## Operational note

Zo Ask is the account's main model and is first in the ladder. It has no streaming
endpoint, so in normal operation compose resolves buffered and `final_delta` fires
once with the whole answer. This is the intended, accepted behaviour — the UI path
is identical either way. Real token streaming engages when a turn falls through to
OpenCode/NIM or when a registry model serves.

## Known gaps (reported, deliberately NOT fixed here)

- The forced-final paths in `loop.ts` (`MAX_STEPS` exhausted, ~L420 and ~L581)
  emit `parsed.message` directly, bypassing compose entirely. Pre-existing from 8.1.
- The abort timer guards response HEADERS only, so a provider that opens a stream
  and then stalls mid-body has no timeout. `complete()` has the same shape, but a
  stream holds the connection far longer, making it reachable rather than theoretical.
- Empty-stream semantics diverge: opencode/nim throw `upstream`; the registry
  paths return `''`, which falls through but logs `ok: true` into `ai_usage`.
- `ai_models.good` is unreachable from the product UI — both API routes accept it,
  `src/components/ModelsProviders.tsx` never sends it. Task-aware routing from 8.1
  is therefore DB-write-only. Not blocking while Zo Ask is the sole model.

## Reviewer checklist (human — do not self-certify)

- [ ] Deltas cannot become authoritative: `final` overwrites, never appends.
- [ ] Fallback to draft is still unconditional (catch-all + empty-result check).
- [ ] `generateChat` / `callModel` diffs are import-only.
- [ ] Route-pass settings untouched — diff `temperature: 0.2` / `maxOutputTokens: 700`.
- [ ] No new DB queries; nothing bypasses `account_id` scoping.
