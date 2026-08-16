# PACKET 2.1 — Capability Registry core (pure port, zero behaviour change)

**Tier:** A · **Branch:** `feat/copilot-remediation`
**Depends on:** Phase 0 and Phase 1 merged (they touch the same files).
**Blocks:** 2.2 (all domain backfills), 2.2-S (social), Phase 4 (MCP bridge).
**Parent plan:** `COPILOT_REMEDIATION_PLAN.md` §2.

---

## Executor preamble (obey exactly)

You are an executor. Implement EXACTLY this packet against the repo at `/Users/franckiemacair/Desktop/LeadRail`.

1. Touch ONLY the files under **Files**. If you believe another file must change, STOP and report why — do not change it.
2. Do not rename exported symbols, change existing function signatures, or alter DB column names unless told to.
3. Preserve the existing comment style: explain WHY, mark additive changes as additive.
4. After editing run `npx tsc --noEmit && npm run build`. Paste both outputs.
5. Output a unified diff of every file changed. No summary prose.
6. If any instruction is ambiguous, STOP and ask ONE question. Do not guess.

---

## The point of this packet

`COPILOT_IMPLEMENTATION_RESEARCH.md` §1 names hand-writing one tool per API route as **"the trap."** `lib/agent/tools.ts` currently hand-writes 35 tools against ~118 routes, and the gap is invisible until a user asks for something the assistant silently cannot do. This packet builds the registry the research doc prescribed, **without changing a single observable behaviour.**

**Success is defined by nothing happening.** After this packet the agent must answer identically, the MCP server must list identical tools, and the approval gate must fire on exactly the same set of tools. The value is entirely structural: after 2.1, adding a capability is one registry entry instead of edits in four places.

**This is a refactor. If you find yourself improving a description, tightening a schema, or fixing a bug you noticed — STOP and report it instead.** Behaviour changes belong in a later packet where they can be reviewed as changes rather than hidden inside a 35-tool move.

---

## Files

**Create:**
- `lib/capabilities/types.ts`
- `lib/capabilities/registry.ts`
- `lib/capabilities/ventures.ts`
- `lib/capabilities/campaigns.ts`
- `lib/capabilities/leads.ts`
- `lib/capabilities/outreach.ts`
- `lib/capabilities/crm.ts`
- `lib/capabilities/knowledge.ts`
- `lib/capabilities/creative.ts`

**Modify:**
- `lib/agent/tools.ts` — becomes a thin adapter over the registry
- `lib/agent/loop.ts` — delete the `deriveMetrics` switch, read `capability.metrics` instead

Do not modify anything else. In particular: no route files, no service files under `lib/` other than the two above, no UI.

---

## Step 1 — `lib/capabilities/types.ts`

```ts
// The Capability Registry — one declaration per platform action.
//
// This is the single source of truth that COPILOT_IMPLEMENTATION_RESEARCH.md §1
// calls for: the chat tool catalog, the MCP server's tools/list, the approval
// gate, and the audit trail all derive from these entries. Adding a platform
// feature means adding ONE entry here, not editing four files.
//
// Capabilities are THIN wrappers over existing service functions — no business
// logic is reimplemented (this rule carried over from lib/agent/tools.ts).
// Account scope is always passed by the caller from the authenticated session;
// a capability never trusts a client-supplied account id.

import type { z } from 'zod';

export type GateClass =
  | 'read'            // no mutation. runs immediately.
  | 'internal_write'  // mutates only LeadRail state. runs immediately.
  | 'spend'           // consumes credits or ad budget. approval required.
  | 'external_send'   // reaches a real third party. approval required.
  | 'destructive';    // irreversible deletion. approval required.

export interface Capability {
  /** Stable id, camelCase. NEVER renamed once shipped — MCP clients bind to it. */
  name: string;
  /** Grouping for catalog ordering and future filtering, e.g. 'campaigns'. */
  domain: string;
  /** Short human title, shown on approval cards. */
  title: string;
  /** Plain-language, written FOR THE MODEL: what it does and when to use it. */
  description: string;
  gate: GateClass;
  /** JSON Schema, for MCP tools/list. */
  inputSchema: Record<string, any>;
  /** Runtime validation for both callers. */
  zod: z.ZodTypeAny;
  run: (accountId: string, args: any) => Promise<any>;
  /** Optional: truthful per-run metrics derived from a REAL result. Never fabricate. */
  metrics?: (args: any, result: any) => Record<string, number>;
  /** Optional: one-sentence approval summary. Falls back to `${title}: ${JSON.stringify(args)}`. */
  summarize?: (args: any) => string;
}

export const SENSITIVE_GATES: GateClass[] = ['spend', 'external_send', 'destructive'];

export function isSensitive(c: Capability): boolean {
  return SENSITIVE_GATES.includes(c.gate);
}

/** Shared JSON-Schema helpers, moved verbatim from lib/agent/tools.ts. */
export const obj = (props: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
export const S = { string: { type: 'string' }, number: { type: 'number' } } as const;
```

## Step 2 — Split the 35 existing tools into domain files

Move each entry from `TOOLS` in `lib/agent/tools.ts` into the domain file below, converting the object shape: keep `title`, `description`, `inputSchema`, `zod`, `run` **byte-identical**; add `domain`; replace `sensitive: true` with the mapped `gate`.

| File | Capabilities |
|---|---|
| `ventures.ts` | listVentures, getPersona, updatePersona |
| `campaigns.ts` | listAdAccounts, listCampaigns, getCampaign, listAdSets, listAds, listAssets, getInsights, createCampaign, importAsset, launchCampaign, pauseCampaign, syncCampaign, analyzeCampaign |
| `leads.ts` | listLeads, getLead, sourceLeads, enrichLead, updateLeadStatus, listTags, tagLead |
| `outreach.ts` | draftOutreach, sendEmail, listSequences, enrollInSequence |
| `crm.ts` | listConversations, listStages, createDeal, moveDeal, addNote |
| `knowledge.ts` | searchNotion, searchDrive, readNotionPage, readDriveFile |
| `creative.ts` | generateAdCopy |

**Gate mapping — this must reproduce today's `sensitive` flag EXACTLY:**

| Capability | Today | Gate |
|---|---|---|
| launchCampaign | `sensitive: true` | `spend` |
| sourceLeads | `sensitive: true` | `spend` |
| enrichLead | `sensitive: true` | `spend` |
| sendEmail | `sensitive: true` | `external_send` |
| enrollInSequence | `sensitive: true` | `external_send` |
| **everything else (30)** | not sensitive | `read` or `internal_write` |

For the non-sensitive 30, choose `read` for pure queries and `internal_write` for anything that mutates LeadRail state (createCampaign, importAsset, pauseCampaign, syncCampaign, updateLeadStatus, tagLead, createDeal, moveDeal, addNote, updatePersona). **The `read`/`internal_write` split has no behavioural effect today** — both run immediately — so it cannot break anything; it exists so later packets can reason about mutation.

Note `pauseCampaign` stays non-sensitive: pausing *stops* spend. (Packet 1.3 deleted the dead `pauseCampaign` branch in `summarizeProposal` for this reason — do not resurrect it.)

**Cross-tool calls:** several tools call `TOOLS.getCampaign.run(...)` or `TOOLS.getLead.run(...)` for ownership checks (see `listAdSets`, `listAds`, `enrichLead`, `draftOutreach`). Convert these to direct local function references within the domain file — e.g. export a module-local `getCampaignOwned(accountId, id)` and have both the capability and its callers use it. **Do not** leave a capability reaching back into the assembled `TOOLS` map; that would reintroduce the circular coupling this refactor removes.

## Step 3 — `lib/capabilities/registry.ts`

```ts
import type { Capability } from './types';
import { VENTURE_CAPABILITIES } from './ventures';
import { CAMPAIGN_CAPABILITIES } from './campaigns';
import { LEAD_CAPABILITIES } from './leads';
import { OUTREACH_CAPABILITIES } from './outreach';
import { CRM_CAPABILITIES } from './crm';
import { KNOWLEDGE_CAPABILITIES } from './knowledge';
import { CREATIVE_CAPABILITIES } from './creative';

// ORDER MATTERS: toolCatalogForPrompt() renders in this order, and the model's
// routing accuracy is sensitive to catalog ordering. This sequence reproduces
// the original declaration order in lib/agent/tools.ts — do not sort it.
export const CAPABILITIES: Capability[] = [
  ...VENTURE_CAPABILITIES,
  ...CAMPAIGN_CAPABILITIES,
  ...LEAD_CAPABILITIES,
  ...OUTREACH_CAPABILITIES,
  ...CRM_CAPABILITIES,
  ...KNOWLEDGE_CAPABILITIES,
  ...CREATIVE_CAPABILITIES,
];

export const CAPABILITY_BY_NAME: Record<string, Capability> =
  Object.fromEntries(CAPABILITIES.map((c) => [c.name, c]));
```

⚠ **Ordering is the one place this "pure port" can silently regress.** The original `TOOLS` object literal has a specific key order. Reproduce it exactly — see the acceptance criteria, which require a byte-identical catalog diff.

## Step 4 — `lib/agent/tools.ts` becomes an adapter

Keep **every existing export with an identical signature**: `AgentTool`, `TOOLS`, `runTool`, `toolSpecs`, `toolCatalogForPrompt`, `ToolRunResult`. Nothing downstream changes.

```ts
// Shared LeadRail tool registry — now an ADAPTER over lib/capabilities.
//
// The tool definitions moved to lib/capabilities/* (Packet 2.1) so that one
// declaration feeds the chat loop, the MCP server, the approval gate, and the
// audit trail. This file keeps its original exports byte-compatible so the two
// front doors — app/api/mcp/route.ts and lib/agent/loop.ts — are untouched.

import { CAPABILITIES, CAPABILITY_BY_NAME } from '@/lib/capabilities/registry';
import { isSensitive, type Capability } from '@/lib/capabilities/types';

export interface AgentTool { /* unchanged shape */ }

export const TOOLS: Record<string, AgentTool> = Object.fromEntries(
  CAPABILITIES.map((c) => [c.name, {
    title: c.title,
    description: c.description,
    inputSchema: c.inputSchema,
    zod: c.zod,
    sensitive: isSensitive(c),
    run: c.run,
  }]),
);

export function capabilityFor(name: string): Capability | undefined {
  return CAPABILITY_BY_NAME[name];
}
```

`toolCatalogForPrompt()`, `toolSpecs()`, and `runTool()` keep their existing bodies unchanged — they read `TOOLS`, which is now derived. Add `capabilityFor` as a new export so `loop.ts` can reach `metrics` and `summarize`.

## Step 5 — `lib/agent/loop.ts`: delete `deriveMetrics`, use `capability.metrics`

`deriveMetrics` is a switch statement over tool names sitting in the loop — exactly the kind of per-feature edit the registry exists to eliminate.

1. **Delete** the whole `deriveMetrics` function (≈line 200).
2. Move each `case` into its capability's `metrics` fn, preserving the logic verbatim — including the `arrLen` helper's handling of `people` / `leads` / `results` shapes. Capabilities with no case get no `metrics` (equivalent to today's `default: return {}`).
3. At the two `emit({ type: 'observation', … })` call sites in `runAgentStream`, replace `deriveMetrics(tool, args, res.result)` with:
   ```ts
   metrics: res.ok ? (capabilityFor(tool)?.metrics?.(args, res.result) ?? {}) : {},
   ```
4. Same treatment for `summarizeProposal`: keep the function, but let a capability's own `summarize` win when present:
   ```ts
   function summarizeProposal(tool: string, args: Record<string, any>): string {
     const cap = capabilityFor(tool);
     if (cap?.summarize) return cap.summarize(args);
     /* existing per-tool branches unchanged below */
   }
   ```
   In this packet no capability defines `summarize`, so every existing branch still fires and output is unchanged. Later packets (2.2-S) add `summarize` and the branch list stops growing.

---

## Acceptance criteria — the bar is "nothing changed"

1. `npx tsc --noEmit` and `npm run build` pass.
2. **Catalog parity.** Before your first edit, capture the baseline:
   ```
   node -e "require('ts-node/register');const{toolCatalogForPrompt}=require('./lib/agent/tools.ts');console.log(toolCatalogForPrompt())" > /tmp/catalog-before.txt
   ```
   (or any equivalent that renders it). After the refactor, regenerate to `/tmp/catalog-after.txt` and run `diff`. **The diff must be empty.** Paste the diff command and its (empty) output in your report. If you cannot execute the catalog function standalone, say so and instead paste both the original `TOOLS` key order and the new `CAPABILITIES.map(c=>c.name)` order for manual comparison.
3. `toolSpecs()` returns exactly 35 entries with the same names and schemas.
4. `Object.keys(TOOLS).filter(n => TOOLS[n].sensitive)` returns exactly: `launchCampaign`, `sourceLeads`, `enrichLead`, `sendEmail`, `enrollInSequence` — **five, no more, no fewer.**
5. `deriveMetrics` no longer exists in `lib/agent/loop.ts`. Grep must return zero hits.
6. No capability references the `TOOLS` map (grep the `lib/capabilities/` tree for `TOOLS` — zero hits).
7. No file outside the **Files** list was modified.
8. Every capability name is unique (`new Set(names).size === names.length`).

## Reviewer checklist (human/architect — do not self-certify)

- [ ] Catalog diff is genuinely empty, not "close enough."
- [ ] The sensitive set is exactly the original five. A tool that silently lost `sensitive` would let a paid campaign launch without approval — this is the single highest-risk error in the packet.
- [ ] Every `run` body was moved verbatim; no description was "improved," no schema tightened.
- [ ] Cross-tool ownership checks (`listAdSets`, `listAds`, `enrichLead`, `draftOutreach`) still enforce ownership via a local helper, not a `TOOLS` lookup.
- [ ] `metrics` fns reproduce the old switch cases exactly, including `arrLen`'s shape handling.
- [ ] Registry order matches the original object-literal order.
