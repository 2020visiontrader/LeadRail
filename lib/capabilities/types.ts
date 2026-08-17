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
  | 'destructive'     // irreversible deletion. approval required.
  // Additive (Packet 2.2-S): creates or switches on a rule that will send on
  // its own, repeatedly, with no further human in the loop. The existing gates
  // cannot express that — approving one send authorises one action, approving
  // a standing rule authorises an unbounded stream of them. Sensitive like the
  // others, so isSensitive() and the approval gate work unchanged; what differs
  // is that its `summarize` MUST state the ongoing nature and the cap.
  | 'standing_rule';

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

export const SENSITIVE_GATES: GateClass[] =
  ['spend', 'external_send', 'destructive', 'standing_rule'];

export function isSensitive(c: Capability): boolean {
  return SENSITIVE_GATES.includes(c.gate);
}

/** Shared JSON-Schema helpers, moved verbatim from lib/agent/tools.ts. */
export const obj = (props: Record<string, any>, required: string[] = []) =>
  ({ type: 'object', properties: props, required, additionalProperties: false });
export const S = { string: { type: 'string' }, number: { type: 'number' } } as const;
