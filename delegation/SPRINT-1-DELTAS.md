# Sprint 1 deltas — read BEFORE executing packets 1.1, 1.2 or 1.3

`COPILOT_REMEDIATION_PLAN.md` sections 1.1–1.3 were written before packets 2.1,
0.1, 0.2, 0.2b, 8.1, 8.1b and 8.2 landed. The plan sections are still the spec.
This file records only where the ground has moved under them.

Verified against the working tree at commit `e99472a`.

---

## Packet 1.1 — the file list is wrong, and following it literally produces a bad diff

**The plan says:** *"Add to `TOOLS` in `lib/agent/tools.ts`"*.

**Reality after 2.1:** `lib/agent/tools.ts` is now a thin adapter. `TOOLS` is
derived, not declared:

```ts
export const TOOLS: Record<string, AgentTool> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, { ...  }]),
);
```

Tool definitions live in `lib/capabilities/*.ts` (`campaigns`, `creative`, `crm`,
`knowledge`, `leads`, `outreach`, `ventures`). Adding a literal to `tools.ts`
would either be overwritten by the derivation or fork the declaration that 2.1
existed to unify — and it would be invisible to the MCP server and the approval
gate, which read the same registry.

**Correct approach for `rememberFact` / `forgetFact` / `listFacts`:**

1. Declare them as `Capability` objects. `knowledge.ts` is the natural home; a
   new `memory.ts` domain file is also acceptable if that reads better.
2. **Append each name to `CATALOG_ORDER` in `lib/capabilities/registry.ts`.**
   Read the comment above that array first — it is explicitly ordered to keep
   `toolCatalogForPrompt()` byte-stable, and the model's routing accuracy depends
   on it. Append; never sort.
3. Sensitivity is expressed as `gate`, not a `sensitive: true` flag.
   `isSensitive(c)` returns `SENSITIVE_GATES.includes(c.gate)`. These three are
   internal writes with no spend and no external effect — use the same
   non-sensitive gate `pauseCampaign` uses (`'internal_write'`). The plan's
   reviewer checklist point ("confirm `rememberFact` is NOT marked sensitive —
   it would deadlock the loop on approval") still applies, just via `gate`.
4. The registry fails loudly at import if a capability is missing from
   `CATALOG_ORDER`, so a partial job breaks the build rather than silently
   dropping a tool. That is the intended safety net — do not work around it.

**Migration number:** the plan's optional `migrations/039_memory_ui.sql` must
become **`040_memory_ui.sql`**. 038 was taken by 8.1b (`038_model_output_limits`)
and 039 by packet 0.3 (`039_mcp_keys`).

**Still accurate:** `recordFact` has exactly one reference in the repo — its own
declaration at `lib/agent/memory.ts:138`. Zero callers. The premise holds.

---

## Packet 1.2 — step 3's first bullet is already done

**Done by 0.2:** `AgentConsole` already holds the conversation id in
`conversationIdRef`, set from the trailing `conversation` SSE event, and echoes
it on the next turn. Do not redo this. `CommandBar` got the same treatment in
0.2b.

**Also changed by 0.2:** the server is now the sole owner of transcripts, so
"refresh = chat gone" is no longer a persistence bug — the data is in
`agent_conversations` and a follow-up turn already reloads it server-side. What
remains is purely a **UI rehydration** gap: the browser doesn't repaint prior
turns after a refresh. Scope the packet to that, not to persistence.

**Still to do, unchanged:** `listConversationsForAccount`, the
`GET /api/agent/conversations` routes, the `compaction_suggested` branch and
banner, the carryover button, mount-time rehydration, and the `AssistantDock`
history list.

**New consideration from 8.2:** `handleEvent` now has two early-return branches
(`final_delta`, `conversation`) that deliberately run *before* the
`patchAssistant` pending-step resolution. Add `compaction_suggested` in a way
that respects that structure — read the comments there before inserting.

---

## Packet 1.3 — all four items still valid, with one scope correction

Verified individually:

1. **`listContacts` is confirmed dead.** No such capability exists; the real name
   is `listLeads`. **Generate the list from `CATALOG_ORDER` in
   `lib/capabilities/registry.ts`, not from the plan's hand-written list** — the
   plan's list predates the registry and is not authoritative.

   **Measured 2026-08-17** (recount before starting; the registry keeps growing):
   59 capabilities, 31 `TOOL_VERB` keys, **29 missing**, 1 dead.

   Missing: `getCampaign`, `listAdSets`, `listAds`, `listAssets`, `getInsights`,
   `listLeads`, `getLead`, `importAsset`, `readNotionPage`, `readDriveFile`,
   `sourceLeads`, `enrichLead`, `draftOutreach`, `sendEmail`, `listSequences`,
   `enrollInSequence`, `listStages`, `createDeal`, `moveDeal`, `addNote`,
   `updateLeadStatus`, `listTags`, `tagLead`, `getPersona`, `updatePersona`,
   `generateAdCopy`, `rememberFact`, `forgetFact`, `listFacts`.

   Dead: `listContacts`.

   Note 2.2-S already added its own 19 verbs, so the social domain is covered —
   the gap is the pre-existing capabilities plus 1.1's three memory tools.

   `verbFor()` falls back to the capability's `title`, so a missing verb is a
   cosmetic degradation, not a crash. That is why this is Tier C. But `sendEmail`
   and `sourceLeads` are in the missing list, and those are the steps a user most
   wants to read clearly while they are happening.
2. **`toolCalls` is still declared-and-unused in `runAgent`** (`lib/agent/loop.ts:337`;
   the used copy is at 493 in the stream variant). Apply the cap, per the plan.
3. **`pauseCampaign` is confirmed non-sensitive** — `gate: 'internal_write'` at
   `lib/capabilities/campaigns.ts:151`. So the plan's decision stands: leave it
   non-sensitive and delete the dead `summarizeProposal` branch at
   `lib/agent/loop.ts:187`. Record the decision in a comment so it is not re-added.
4. **Scope correction.** The plan asks for a comment saying *"Keep behaviourally
   identical to runAgent."* The two variants are now **intentionally** different:
   8.1/8.2 gave `runAgentStream` an `emit` channel, `final_delta` streaming, and
   a `composeAnswer` `onDelta` argument that `runAgent` deliberately does not
   pass. Word the invariant as **loop control only** — step cap, dedupe, repeat-
   tool cap — not "behaviourally identical", which is now false and would invite
   someone to "fix" the streaming divergence.

**Ordering:** 1.3's verb table should include `rememberFact` etc., which only
exist after 1.1. Either run 1.3 after 1.1, or omit the memory verbs and note it.

---

## Applies to all three

- Grep before trusting any file path in the plan: 2.1 moved tool declarations,
  0.2 moved transcript ownership, 8.2 added four AI transport entry points.
- The standing rules in `README.md` are unchanged and still binding.
