// lib/agent/tools.ts
// Thin adapter over lib/capabilities/* (Packet 2.1).
// Tool definitions moved to capabilities so one declaration feeds the chat loop,
// the MCP server, the approval gate, and the audit trail.
// Exports stay byte-compatible so app/api/mcp/route.ts and lib/agent/loop.ts need no changes.

import { z } from 'zod';
import { CAPABILITIES, CAPABILITY_BY_NAME } from '@/lib/capabilities/registry';
import { isSensitive, type Capability } from '@/lib/capabilities/types';

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
