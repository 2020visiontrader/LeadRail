# PACKET 10.3 — Two-stage tool catalog

**Tier:** B · **Branch:** `feat/copilot-remediation` · **Depends on:** 2.1 merged.
**BLOCKING for packet 5.1** — land this first or the skills harvest breaks the prompt.

---

## The problem

`toolCatalogForPrompt()` renders **every** capability into **every** system
prompt, on every hop of the loop:

```ts
return Object.entries(TOOLS).map(([name, t]) => { … }).join('\n');
```

At 40 capabilities that is fine and should be left alone.

It stops being fine on two upcoming events, both already on the queue:

- **Packet 2.2-S** adds ~14 social capabilities.
- **Packet 5.1** harvests **~405 skills**. Skills are injected separately by
  `loadEnabledSkillsForAgent`, but the same all-or-nothing shape applies, and the
  two blocks share one prompt budget.

The route pass runs at `maxOutputTokens: 700` with the whole catalog in its
input on every hop. Growing the catalog by an order of magnitude degrades
routing accuracy (more candidates, less attention per candidate) *and* costs
input tokens on every hop of every turn.

## The change

Stage the catalog: show domains and a compact index first; expand one domain's
full signatures on demand.

`Capability` already carries `domain` (`campaigns`, `creative`, `crm`,
`knowledge`, `leads`, `outreach`, `ventures`, `memory`), so the grouping exists.

Suggested shape — adjust if the code suggests better:

1. `toolCatalogForPrompt()` keeps its **exact current output** and current
   callers. Do not change it. Other packets assert on it (8.1 acceptance
   criterion 7, 2.1's catalog-parity requirement), and `CATALOG_ORDER` exists
   specifically to keep it byte-stable.
2. Add a NEW `toolCatalogStaged()` returning the compact form: one line per
   domain with capability names only, no arg signatures.
3. Add a capability — `describeTools(domain)` — returning full signatures for one
   domain. Gate `read`. It is how the model expands what it needs.
4. Switch `systemPrompt()` to the staged form **behind an env flag**, defaulting
   to today's behaviour:
   `AGENT_STAGED_CATALOG = process.env.AGENT_STAGED_CATALOG === '1'`
   Opt-IN, not opt-out — this changes routing, and routing regressions are
   expensive. Flip the default only after measurement.

## Files

**Modify:** `lib/agent/tools.ts`, `lib/agent/loop.ts`, `lib/capabilities/registry.ts`
**Create:** a capability for `describeTools` in an existing domain file

Do not touch `lib/skills/*` — skills staging is a sibling problem and belongs
with packet 5.1, which should follow the same pattern once this lands.

## Constraints

- **`toolCatalogForPrompt()` output must not change.** It is the parity anchor
  from 2.1 and an acceptance criterion in 8.1.
- `describeTools` must be registered in `CATALOG_ORDER` like any other capability
  — appended, never sorted.
- With the flag off, the assembled system prompt must be byte-identical to today.
  Verify this, do not assume it.
- The staged form must still tell the model that sensitive tools need approval —
  losing the `[needs approval]` marker would let the model plan around a gate it
  cannot see.

## Acceptance criteria

1. `./node_modules/.bin/tsc --noEmit` and `npm run build` pass.
2. `AGENT_STAGED_CATALOG` unset → system prompt byte-identical to today. Show the
   comparison you ran.
3. `toolCatalogForPrompt()` output unchanged.
4. Staged output preserves the sensitivity marker for every sensitive capability.
5. `describeTools` returns signatures for exactly one domain and is `read`-gated.
6. An unknown domain argument returns a clean error, not an empty string.

## Reviewer checklist (human — do not self-certify)

- [ ] Flag-off path proven byte-identical, not assumed.
- [ ] Sensitivity markers survive staging.
- [ ] `describeTools` cannot enumerate another account's anything — it is static
      registry data only, with no `account_id` dimension. Confirm it takes no
      per-account input.
- [ ] Routing quality compared flag-on vs flag-off on a set of real requests
      before anyone proposes changing the default.
