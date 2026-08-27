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

// --- Diagnostic analysis (structured finding/claim/verdict/evidence) -------
// A capability may optionally produce a grounded analysis of its OWN result,
// surfaced to the user as structured cards instead of prose. Four layers,
// same truthful discipline as `digest`/`metrics` below: never fabricate,
// never infer a number the result does not contain.
//
//   Evidence — a real, citable data point pulled from the result.
//   Claim    — an assertion derived from evidence, carrying its `basis` so the
//              UI can render "measured" vs "rule of thumb" differently. EVERY
//              claim a capability considers is emitted, whether or not it
//              clears the bar to become a finding — a claim that didn't
//              qualify is still true, it's just not surfaced as actionable.
//   Finding  — a claim that cleared a minimum-evidence bar and is worth the
//              user's attention. References its claim by id; does not repeat
//              the text.
//   Verdict  — one synthesis across this turn's findings. Omitted (not a
//              fabricated "no issues found") when there is nothing to say.
export type Basis =
  | { kind: 'direct_observation' }               // read straight off the artifact under analysis
  | { kind: 'crm_history'; n: number }            // measured over n real rows — n MUST be real
  | { kind: 'heuristic'; rule: string };          // a named rule of thumb, not a measurement

export interface Evidence {
  id: string;
  label: string;
}

export interface Claim {
  id: string;
  text: string;
  basis: Basis;
  evidenceIds: string[];
}

export interface Finding {
  id: string;
  claimId: string;
  severity: 'low' | 'medium' | 'high';
  recommendation?: string;
}

export interface Verdict {
  summary: string;
  findingIds: string[];
}

export interface Analysis {
  evidence: Evidence[];
  claims: Claim[];
  findings: Finding[];
  verdict?: Verdict;
}

/** Server-derived, never model-supplied. See Capability.run. */
export interface CapabilityContext {
  conversationId?: string | null;
  brandId?: string | null;
  requestedBy?: string | null;
  /** Plan mode: write the plan, do not start executing it. */
  planOnly?: boolean;
}

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
  /** Turn-scoped context, when the caller has it. OPTIONAL and third so every
   *  existing two-parameter implementation still satisfies this type — a
   *  capability that does not need it simply omits it.
   *
   *  It exists because a few capabilities need server-owned facts the MODEL
   *  must never supply: which conversation this is (plans, grants and memory
   *  are all keyed on it) and whether the turn is in plan-only mode. Asking the
   *  model to pass a conversation id would make it forgeable. */
  run: (accountId: string, args: any, ctx?: CapabilityContext) => Promise<any>;
  /** Optional (Packet 1.4): true when THESE arguments commit real spend even
   *  though the capability's gate class is not 'spend'. The spend budget gate
   *  in runTool() fires on `gate === 'spend' || spendsMoney?.(args)`.
   *
   *  Exists because "reaches a third party" and "costs money" are not the same
   *  axis: setAdStatus is external_send for every call, but only status:'ACTIVE'
   *  restarts a live ad. Declaring that here keeps the money gate arg-aware
   *  without a per-name special case inside the chokepoint, and without
   *  reclassifying a gate (which would change approval and audit semantics). */
  spendsMoney?: (args: any) => boolean;
  /** Optional: truthful per-run metrics derived from a REAL result. Never fabricate. */
  metrics?: (args: any, result: any) => Record<string, number>;
  /** Optional: a larger OBSERVATION budget for this capability, in characters.
   *
   *  The default (OBSERVATION_CHAR_LIMIT in lib/agent/loop.ts) exists to stop a
   *  chatty tool result from flooding the transcript, and for almost every
   *  capability that is right — the model needs enough of the result to REASON
   *  over, not all of it.
   *
   *  A few capabilities are different: their result is not evidence, it IS the
   *  deliverable. analyzeBrand returns the marketing strategy the user asked
   *  for; truncating it does not trim context, it destroys the answer. Worse,
   *  truncation cuts from the END, and the end of a strategy is `unknowns` —
   *  the questions the assistant is supposed to ask instead of inventing facts.
   *  The honesty mechanism was the first thing being deleted.
   *
   *  Keep at or under OBSERVATION_BLOCK_CHARS (lib/agent/compose.ts): that is
   *  the total the compose pass receives, so a value above it is not bigger —
   *  it is re-clipped there instead, silently. Do not restate the number here;
   *  two caps in series disagreeing is the exact failure this field fixes. */
  observationLimit?: number;
  /** Optional: one-sentence approval summary. Falls back to `${title}: ${JSON.stringify(args)}`.
   *  NOTE (Packet 10.1): this runs BEFORE the tool does — it renders the approval
   *  card and the audit trail, so it structurally cannot see a result. Its
   *  signature is fixed. Result-aware wording belongs in `digest` below. */
  summarize?: (args: any) => string;
  /** Optional (Packet 10.1): a short, plain-language rendering of a REAL result,
   *  written for the model that will reason over it. It is placed FIRST in the
   *  OBSERVATION line, ahead of the raw JSON, so blind truncation cannot remove it.
   *
   *  Truthful only. A digest may state ONLY what is present in `result`: never
   *  infer, never round a value the result does not contain, never default a
   *  missing field to zero. The compose pass treats these lines as fact, so a
   *  guess here launders a fabrication into something the model trusts.
   *
   *  Never emit a secret, token, or credential — these lines reach the model
   *  verbatim. Return '' (or omit the field) and the raw JSON is used alone. */
  digest?: (args: any, result: any) => string;
  /** Optional: a grounded structured analysis of a REAL result (see `Analysis`
   *  above), streamed to the UI as evidence/claim/finding/verdict events
   *  alongside the plain observation. Same rule as `digest`: truthful only,
   *  every number must come from `result`. A best-effort presentation hook,
   *  never a gate — a throwing or absent `findings` degrades to no analysis
   *  events, never blocks the tool call itself. */
  findings?: (args: any, result: any) => Analysis | null;
}

// --- Digest helpers (Packet 10.1) -------------------------------------------
// Shared by the per-capability `digest` implementations. Every helper is
// strictly truthful: it reports only values actually present on the result. A
// missing field yields NOTHING — never a zero, never a placeholder.

/** True when `o` carries a usable (non-null, non-empty) value at `k`. */
export function present(o: any, k: string): boolean {
  if (!o || typeof o !== 'object') return false;
  const v = (o as any)[k];
  return v !== null && v !== undefined && v !== '';
}

/** Rows only when the result really IS an array. Otherwise null, so the caller
 *  emits no digest at all rather than guessing at an unknown shape. */
export function rowsOf(result: any): any[] | null {
  return Array.isArray(result) ? result : null;
}

/** The first present field from `keys`, stringified. null when none are present. */
export function firstField(o: any, keys: string[]): string | null {
  for (const k of keys) if (present(o, k)) return String((o as any)[k]);
  return null;
}

/** `${n} thing` / `${n} things` — a count and nothing else. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "3 qualified, 9 new" over the rows that actually carry `key`. Rows without
 *  it are neither counted nor mentioned; null when no row carries it. */
export function tally(rows: any[], key: string, max = 4): string | null {
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!present(r, key)) continue;
    const v = String((r as any)[key]);
    counts.set(v, (counts.get(v) || 0) + 1);
  }
  if (!counts.size) return null;
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([v, n]) => `${n} ${v}`)
    .join(', ');
}

/** Up to `n` concrete labels, each taken from the first present key on its row.
 *  Rows with none of the keys are skipped rather than described. */
export function samples(rows: any[], keys: string[], n = 3): string[] {
  const out: string[] = [];
  for (const r of rows) {
    if (out.length >= n) break;
    const l = firstField(r, keys);
    if (l) out.push(clip(l, 60));
  }
  return out;
}

/** Single-line, length-bounded rendering of a value that came from the result. */
export function clip(s: string, max = 80): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** Join the non-empty parts of a digest. Returns '' when nothing was truthful
 *  enough to say — the loop then falls back to the raw JSON alone. */
export function digestLine(...parts: (string | null | undefined)[]): string {
  return parts.filter((p): p is string => !!p && p.trim() !== '').join(' ');
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
