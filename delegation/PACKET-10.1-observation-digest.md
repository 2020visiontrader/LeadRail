# PACKET 10.1 — Give the model observations it can actually read

**Tier:** B · **Branch:** `feat/copilot-remediation` · **Depends on:** 2.1, 8.1 merged.

---

## The problem

A tool result reaches the model as blind-truncated JSON. In `lib/agent/loop.ts`:

```ts
const obs = res.ok ? JSON.stringify(res.result) : `ERROR: ${res.error}`;
messages.push(observation(obs));            // truncate() applied to the emitted copy
```

Then the compose pass (`lib/agent/compose.ts`) scrapes `OBSERVATION: ` lines and
caps the block at 6000 chars, newest-first.

So a 40-lead result becomes a JSON string chopped at a character boundary —
frequently mid-object, mid-key. The compose prompt then instructs the model to
**ground every factual claim in the OBSERVATION lines**, and those lines are a
fragment. The model is being asked to be rigorous about a mutilated source.

This is the single largest answer-quality leak in the loop. It is not a prompt
problem and no amount of prompt tuning fixes it.

## The fix

Let each capability say what its own result means, in language, and put THAT in
the transcript alongside the raw data.

There is already a precedent for a result-aware hook on `Capability`:

```ts
metrics?: (args: any, result: any) => Record<string, number>;
```

Add a sibling.

### ⚠ Naming — do not overload `summarize`

`Capability.summarize?: (args: any) => string` **already exists and takes only
`args`**. It renders the approval card BEFORE a tool runs, so it cannot see a
result. Do not change its signature or reuse it — that would break every
approval card and packet 0.1's audit trail.

Add a NEW optional field. `digest` is the suggested name:

```ts
/** Optional: a short, plain-language rendering of a REAL result, written for
 *  the model that will reason over it. Truthful only — never fabricate, never
 *  round a number the result does not contain. Omit and the raw JSON is used. */
digest?: (args: any, result: any) => string;
```

## Files

**Modify:** `lib/capabilities/types.ts`, `lib/agent/loop.ts`, and the capability
domain files you add digests to (`leads.ts`, `campaigns.ts`, `crm.ts`,
`outreach.ts`, `knowledge.ts`, `ventures.ts`, `creative.ts`).

Do NOT modify `lib/agent/compose.ts` — its `OBSERVATION:` scraping keeps working
unchanged, it just receives better content. If you think compose must change,
STOP and report.

## Steps

**1. Add `digest` to the `Capability` type.** Optional, additive. Every existing
capability without one behaves exactly as today.

**2. Use it in BOTH loop variants** (`runAgent` and `runAgentStream` — they must
stay behaviourally identical on loop control). Where the observation is built:

- On success with a digest: put the digest FIRST, then the raw JSON, both under
  the same `OBSERVATION:` line prefix that compose scrapes. The digest survives
  truncation because it comes first; the raw data remains available while it fits.
- On success without a digest: today's behaviour, byte-identical.
- On error: unchanged.

Keep the existing `truncate()` on the emitted UI copy. The point is that the
*important* part is now at the front of the string rather than wherever the JSON
serializer happened to put it.

**3. Write digests for the highest-volume read capabilities first** — the ones
whose results are large enough to be truncated today: `listLeads`, `getLead`,
`listCampaigns`, `getCampaign`, `getInsights`, `listAdSets`, `listAds`,
`listConversations`, `listSequences`, `searchNotion`, `searchDrive`.

A good digest states counts, the discriminating fields, and the few concrete
items a human would mention — never a restatement of the schema:

```ts
// GOOD: "12 leads (3 qualified, 9 new). Top by score: Acme 88, Beta 81, Gamma 77."
// BAD:  "A list of lead objects with id, name, email, score fields."
```

**Truthfulness is a hard rule.** A digest may only state what is present in
`result`. If a field is absent, say nothing about it — do not infer, do not
default to zero. The compose pass treats these lines as fact.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. `digest` is optional; a capability without one produces a byte-identical
   observation to today. Verify by diffing the observation string for a
   digest-less capability before and after.
3. `Capability.summarize`'s signature is unchanged and no approval card regressed.
4. `runAgent` and `runAgentStream` build observations identically.
5. No digest reads a field the result does not contain.
6. `toolCatalogForPrompt()` output is unchanged — digests are runtime-only and
   must not leak into the tool catalog.

## Reviewer checklist (human — do not self-certify)

- [ ] Spot-check three digests against their capability's real return shape.
- [ ] Confirm no digest fabricates, rounds, or infers a missing value.
- [ ] Confirm the digest precedes the raw JSON, so truncation cannot remove it.
- [ ] Confirm no secret, token, or credential can appear in a digest — the
      compose pass sends these lines to the model verbatim.
