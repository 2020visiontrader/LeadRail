# PACKET 10.2 — Prompt prefix ordering + split plan from narration

**Tier:** B · **Branch:** `feat/copilot-remediation` · **Depends on:** 8.1, 8.2 merged.

Two changes, one packet, because **both edit `systemPrompt()` / the route-pass
protocol in `lib/agent/loop.ts`** and running them separately guarantees a
conflict.

---

## Part A — make the prompt prefix cacheable

### The problem

`systemPrompt()` currently assembles in this order:

```
identity  →  personaBlock  →  skillsGuidance  →  agentContext  →  carryover
          →  HOW YOU WORK  →  toolCatalogForPrompt()
```

`agentContext` and `carryover` are **volatile** — they change per turn, and
`loadAgentContext` is query-specific. `HOW YOU WORK` and the tool catalog are
**static** across every turn for an account.

The volatile blocks sit in the middle. Prompt caching keys on a stable prefix,
so everything after the first volatile byte is uncacheable — which today means
the two largest static blocks in the prompt are the least cacheable parts of it.

### The change

Reorder so all static content precedes all volatile content:

```
identity → personaBlock → skillsGuidance → HOW YOU WORK → toolCatalog
         → agentContext → carryover
```

### ⚠ This is a behaviour-affecting change — treat it as one

Moving grounding from the middle to the end changes what the model attends to
most strongly. Recency helps some tasks and hurts others. Do NOT ship this as a
silent refactor:

- Keep the change to ordering ONLY. Do not reword a single line while moving it.
- The diff should be pure movement — verify by sorting the before/after block
  contents and confirming they are identical sets.
- Report the exact before/after prompt for one representative turn so a reviewer
  can eyeball what moved.

Note LeadRail does not implement provider-side prompt caching yet — this packet
makes the prefix *cacheable*, it does not enable caching. That is a separate
change in `lib/ai/providers.ts` and explicitly out of scope here. Say so in a
comment so the next reader knows the ordering is load-bearing and must not be
casually rearranged.

---

## Part B — split the route pass's `plan` from its `narration`

### The problem

The route pass runs at `temperature: 0.2, maxOutputTokens: 700` with a JSON
envelope. Its `thought` field is doing two jobs at once:

1. the model's internal reasoning about which tool to call, and
2. the line the user reads in the live step trace.

Both are squeezed into one 700-token budget shared with the rest of the JSON, at
a temperature chosen for machine-decision accuracy. The user-facing narration is
therefore written under settings tuned for something else, and capped by
whatever the envelope leaves over.

### The change

Extend the route-pass protocol with a second optional field, e.g.:

```json
{"action":"tool","plan":"…internal…","narration":"…shown to the user…","tool":"…","args":{…}}
```

- `narration` is what `emit({ type: 'thought' })` sends. Short, plain language,
  present tense, no tool or vendor names — same voice rules the compose prompt
  uses.
- `plan` is internal. It stays in the transcript for the model's own continuity
  and is NEVER emitted to the client.
- **Backward compatible:** when `narration` is absent, fall back to `thought`
  exactly as today. A model that ignores the new field must still work.

### Constraints

- **Do not change `temperature: 0.2` or `maxOutputTokens: 700`.** They are correct
  for routing and packet 8.1 requires them untouched. If narration genuinely does
  not fit, report that rather than raising the budget unilaterally.
- Apply to BOTH `runAgent` and `runAgentStream`. `runAgent` has no `emit`, so it
  simply ignores `narration` — but the parsing must be identical in both.
- The JSON protocol description in `systemPrompt()` must document the new field
  in the same style as the existing ones.

## Files

**Modify:** `lib/agent/loop.ts` only.

If `lib/agent/compose.ts` or the SSE route appears to need a change, STOP and
report — `thought` events already flow through untouched.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. Part A is pure movement: the set of prompt blocks is unchanged, only order.
3. Nothing static appears after anything volatile in the assembled prompt.
4. A route response with no `narration` behaves exactly as today (`thought` used).
5. `plan` never reaches the client — grep the emit sites.
6. Route-pass `temperature: 0.2` / `maxOutputTokens: 700` are untouched.
7. `runAgent` and `runAgentStream` parse the envelope identically.

## Reviewer checklist (human — do not self-certify)

- [ ] Read the before/after prompt for one turn; confirm only order changed.
- [ ] Confirm the ordering comment explains WHY, so it is not casually undone.
- [ ] Confirm `plan` is absent from every SSE event payload.
- [ ] Confirm the fallback path is genuinely unconditional, not best-effort.
- [ ] Sanity-check routing quality on a few multi-tool requests — Part A can shift
      tool selection, and that is the risk this packet carries.
