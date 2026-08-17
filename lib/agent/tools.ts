// lib/agent/tools.ts
// Thin adapter over lib/capabilities/* (Packet 2.1).
// Tool definitions moved to capabilities so one declaration feeds the chat loop,
// the MCP server, the approval gate, and the audit trail.
// Exports stay byte-compatible so app/api/mcp/route.ts and lib/agent/loop.ts need no changes.

import { z } from 'zod';
import { CAPABILITIES, CAPABILITY_BY_NAME, stagedCatalogText } from '@/lib/capabilities/registry';
import { isSensitive, type Capability } from '@/lib/capabilities/types';
import { assertWithinBudget } from '@/lib/budgets/store';

export interface AgentTool {
  title: string;
  description: string;
  /** JSON Schema (NOT a zod schema) — consumed by MCP tools/list and by
   *  toolCatalogForPrompt, which reads .properties/.required off it. */
  inputSchema: Record<string, any>;
  zod: z.ZodTypeAny;
  sensitive?: boolean;
  run: (accountId: string, args: any) => Promise<any>;
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

/** Compact catalog for the agent system prompt — name, purpose, args, gate. */
export function toolCatalogForPrompt(): string {
  return Object.entries(TOOLS).map(([name, t]) => {
    const args = Object.keys(t.inputSchema.properties || {});
    const req = new Set<string>(t.inputSchema.required || []);
    const sig = args.map((a) => (req.has(a) ? a : `${a}?`)).join(', ') || '—';
    return `${name}(${sig})${t.sensitive ? ' [needs approval]' : ''} — ${t.description}`;
  }).join('\n');
}

/** Two-stage catalog flag (Packet 10.3). Re-exported from the registry so the
 *  loop and the registry can never disagree about which mode is active. */
export { AGENT_STAGED_CATALOG } from '@/lib/capabilities/registry';

/** Staged catalog (Packet 10.3) — stage 1: one line per domain, names only,
 *  approval markers preserved. Roughly an order of magnitude smaller than
 *  toolCatalogForPrompt(), which it does NOT replace: the full form stays the
 *  default and this is used only when AGENT_STAGED_CATALOG=1. The model expands
 *  a domain on demand with the describeTools capability. */
export function toolCatalogStaged(): string {
  return stagedCatalogText();
}

/** Tool specs for MCP tools/list. */
export function toolSpecs() {
  return Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }));
}

export interface ToolRunResult { ok: boolean; result?: any; error?: string }

/** Validate + execute a tool by name. Never throws — errors are returned so
 *  both the loop and the MCP layer can feed them back to the model. */
export async function runTool(name: string, accountId: string, rawArgs: unknown): Promise<ToolRunResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.zod.safeParse(rawArgs ?? {});
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
  const cap = CAPABILITY_BY_NAME[name];
  if (cap && (cap.gate === 'spend' || cap.spendsMoney?.(parsed.data) === true)) {
    try {
      await assertWithinBudget(accountId, cap.title);
    } catch (e: any) {
      return { ok: false, error: e?.message || 'Blocked by this account’s monthly spend limit.' };
    }
  }

  try {
    return { ok: true, result: await tool.run(accountId, parsed.data) };
  } catch (e: any) {
    return { ok: false, error: e?.message || 'tool error' };
  }
}

/** Reach the full Capability (metrics, summarize, gate) behind a tool name.
 *  CAPABILITY_BY_NAME is a Record, not a Map — index it. */
export function capabilityFor(name: string): Capability | undefined {
  return CAPABILITY_BY_NAME[name];
}
