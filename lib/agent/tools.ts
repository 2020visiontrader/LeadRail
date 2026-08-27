// lib/agent/tools.ts
// Thin adapter over lib/capabilities/* (Packet 2.1).
// Tool definitions moved to capabilities so one declaration feeds the chat loop,
// the MCP server, the approval gate, and the audit trail.
// Exports stay byte-compatible so app/api/mcp/route.ts and lib/agent/loop.ts need no changes.

import { z } from 'zod';
import { CAPABILITIES, CAPABILITY_BY_NAME, stagedCatalogText } from '@/lib/capabilities/registry';
import { isSensitive, type Capability, type CapabilityContext } from '@/lib/capabilities/types';
import { assertWithinBudget } from '@/lib/budgets/store';

export interface AgentTool {
  title: string;
  description: string;
  /** JSON Schema (NOT a zod schema) — consumed by MCP tools/list and by
   *  toolCatalogForPrompt, which reads .properties/.required off it. */
  inputSchema: Record<string, any>;
  zod: z.ZodTypeAny;
  sensitive?: boolean;
  run: (accountId: string, args: any, ctx?: CapabilityContext) => Promise<any>;
}

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

/** Build an AgentTool map from an arbitrary capability list — the same shape
 *  TOOLS is built with above, but for a per-account, per-turn capability set
 *  that cannot live in the static registry (Packet 4: an account's connected
 *  external MCP tools, lib/capabilities/external-mcp.ts). Pure mapping, no
 *  side effects, so callers can freely merge the result with TOOLS. */
export function toolsFromCapabilities(caps: Capability[]): Record<string, AgentTool> {
  return Object.fromEntries(
    caps.map((c) => [c.name, {
      title: c.title,
      description: c.description,
      inputSchema: c.inputSchema,
      zod: c.zod,
      sensitive: isSensitive(c),
      run: c.run,
    }]),
  );
}

function catalogLine(name: string, t: AgentTool): string {
  const args = Object.keys(t.inputSchema.properties || {});
  const req = new Set<string>(t.inputSchema.required || []);
  const sig = args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ') || '—';
  return `${name}(${sig})${t.sensitive ? ' [needs approval]' : ''} — ${t.description}`;
}

/** Compact catalog for the agent system prompt — name, purpose, args, gate.
 *  `extraTools` (Packet 4) folds in a per-account, per-turn set — today only
 *  the external-MCP bridge — that cannot live in the static TOOLS map. Omit
 *  it and this is byte-identical to every call site that predates Packet 4. */
export function toolCatalogForPrompt(extraTools?: Record<string, AgentTool>): string {
  const base = Object.entries(TOOLS).map(([name, t]) => catalogLine(name, t));
  const extra = extraTools ? Object.entries(extraTools).map(([name, t]) => catalogLine(name, t)) : [];
  return [...base, ...extra].join('\n');
}

/** Two-stage catalog flag (Packet 10.3). Re-exported from the registry so the
 *  loop and the registry can never disagree about which mode is active. */
export { AGENT_STAGED_CATALOG } from '@/lib/capabilities/registry';

/** Staged catalog (Packet 10.3) — stage 1: one line per domain, names only,
 *  approval markers preserved. Roughly an order of magnitude smaller than
 *  toolCatalogForPrompt(), which it does NOT replace: the full form stays the
 *  default and this is used only when AGENT_STAGED_CATALOG=1. The model expands
 *  a domain on demand with the describeTools capability.
 *
 *  `extraTools` (Packet 4) appends one more "external" domain line, names
 *  only, same approval-marker convention as every other domain — so a
 *  connected MCP client's tools are visible even in staged mode. Omit it and
 *  this is identical to the pre-Packet-4 behaviour. */
export function toolCatalogStaged(extraTools?: Record<string, AgentTool>): string {
  const base = stagedCatalogText();
  if (!extraTools || !Object.keys(extraTools).length) return base;
  const names = Object.entries(extraTools)
    .map(([name, t]) => `${name}${t.sensitive ? ' [needs approval]' : ''}`)
    .join(', ');
  return `${base}\nexternal (${Object.keys(extraTools).length}): ${names}`;
}

/** Tool specs for MCP tools/list. */
export function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

export interface ToolRunResult { ok: boolean; result?: any; error?: string }

/** Validate + execute a tool by name. Never throws — errors are returned so
 *  both the loop and the MCP layer can feed them back to the model.
 *
 *  `extraTools`/`extraCaps` (Packet 4) let a caller fold in a per-account,
 *  per-turn set — today only the external-MCP bridge — that isn't in the
 *  static registry. They are consulted ONLY when `name` isn't a first-party
 *  tool, so every existing call site (both agent routes without a Packet-4
 *  change, the MCP server) behaves exactly as before this packet. */
export async function runTool(
  name: string,
  accountId: string,
  rawArgs: unknown,
  extraTools?: Record<string, AgentTool>,
  extraCaps?: Record<string, Capability>,
  /** The brand the operator currently has selected, when there is one.
   *
   *  BRAND SCOPE HAS TO BE ENFORCED HERE, not asked for in the prompt. 23
   *  capabilities declare a `brandId` parameter and the model had to remember to
   *  pass it on every call; when it forgot, the tool ran across EVERY brand in
   *  the account and nothing said so. With Rentahub selected, listCompanies
   *  returned all nine companies belonging to filmops and retentionrail, and the
   *  answer attributed them to whichever brand the question named. Nine writes
   *  are in that set too, so records could be created under the wrong brand.
   *
   *  Only ever FILLS AN ABSENT value: an explicit brandId from the model always
   *  wins, because "what about FilmOps?" while Rentahub is selected is a real
   *  request, not a mistake.
   *
   *  Omitted by the MCP server on purpose — an API key has no "selected brand",
   *  so there is nothing to default and its behaviour is unchanged. */
  defaultBrandId?: string,
  /** Turn-scoped, server-derived context (migration 063). Optional so the MCP
   *  server path — which has no conversation — is unchanged. */
  ctx?: CapabilityContext,
): Promise<ToolRunResult> {
  const tool = TOOLS[name] ?? extraTools?.[name];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  // Applied BEFORE validation so the parsed args carry it — spendsMoney() and
  // the capability itself must both see the same, scoped arguments.
  let args: any = rawArgs ?? {};
  if (defaultBrandId && args && typeof args === 'object' && !Array.isArray(args)) {
    const cap0 = CAPABILITY_BY_NAME[name] ?? extraCaps?.[name];
    const declaresBrand = Boolean(cap0?.inputSchema?.properties?.brandId);
    const absent = args.brandId === undefined || args.brandId === null || args.brandId === '';
    if (declaresBrand && absent) args = { ...args, brandId: defaultBrandId };
  }

  const parsed = tool.zod.safeParse(args);
  if (!parsed.success) return { ok: false, error: `Invalid arguments: ${parsed.error.message}` };

  // SPEND GATE (Packet 1.4). This is the one place any capability is executed —
  // the chat loop (both the streaming and non-streaming variants, including the
  // post-approval resume) and the MCP server all funnel through here — so the
  // monthly budget is enforced once, for every entrance, and can't be forgotten
  // when a new spend-gated capability is added.
  //
  // It runs AFTER argument validation (so spendsMoney sees parsed args) and
  // BEFORE tool.run(), i.e. before any external call: money that has already
  // left cannot be un-spent by a later check.
  //
  // The catch is NOT a silent catch — assertWithinBudget() has already made the
  // fail-closed decision and produced a user-facing reason; this only converts
  // its throw into runTool's never-throws {ok,error} contract, preserving the
  // message so it reaches the model and the user intact.
  const cap = CAPABILITY_BY_NAME[name] ?? extraCaps?.[name];
  if (cap && (cap.gate === 'spend' || cap.spendsMoney?.(parsed.data) === true)) {
    try {
      await assertWithinBudget(accountId, cap.title);
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Blocked by this account’s monthly spend limit.' };
    }
  }

  try {
    return { ok: true, result: await tool.run(accountId, parsed.data, ctx) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'tool error' };
  }
}

/** Reach the full Capability (metrics, summarize, gate) behind a tool name.
 *  CAPABILITY_BY_NAME is a Record, not a Map — index it. `extraCaps` (Packet 4)
 *  is consulted only when `name` isn't a first-party capability, so every call
 *  site that doesn't pass it behaves exactly as before this packet. */
export function capabilityFor(name: string, extraCaps?: Record<string, Capability>): Capability | undefined {
  return CAPABILITY_BY_NAME[name] ?? extraCaps?.[name];
}
