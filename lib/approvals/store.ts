// Durable approvals store (migration 028_approvals.sql). Persists the agent's
// sensitive-tool proposals ADDITIVELY alongside the existing in-memory
// needs_approval/resume flow in lib/agent/loop.ts — this table is an audit
// trail with actor/comment/no-self-approval/edit-invalidation, not a new
// execution path. The transcript-resume mechanism in loop.ts is unchanged.
//
// Mirrors the CRUD shape in lib/mcp/clients.ts: account_id is always
// server-derived, args_encrypted is encrypted at rest via the same vault
// (lib/ai/crypto.ts) and never returned decrypted to a client — only
// args_redacted (safe-to-display) + has_encrypted_args (boolean) are exposed.

import { createHash } from 'node:crypto';
import { supabase } from '@/lib/db';
import { decryptSecret, encryptSecret, vaultConfigured } from '@/lib/ai/crypto';
// TYPE-ONLY. Erased at compile time, so this cannot re-open the registry ->
// capabilities -> db import cycle that Packet D2 had to break (see
// lib/capabilities/registry.ts). Never make this a value import.
import type { GateClass } from '@/lib/capabilities/types';

// 'executed' (migration 037) is TERMINAL and makes this row authoritative for
// execution: consumeApprovalForExecution flips approved -> executed atomically,
// so an approval is single-use and a rejected one can never run.
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired' | 'invalidated' | 'executed';

export interface ApprovalRow {
  id: string;
  account_id: string;
  conversation_id: string | null;
  tool: string;
  title: string;
  summary: string;
  args_encrypted: string | null;
  args_redacted: Record<string, any>;
  args_hash: string;
  state: ApprovalState;
  requested_by: string | null;
  decided_by: string | null;
  decided_at: string | null;
  comment: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SafeApproval = Omit<ApprovalRow, 'args_encrypted'> & { has_encrypted_args: boolean };

function toSafe(row: ApprovalRow): SafeApproval {
  const { args_encrypted, ...rest } = row;
  return { ...rest, has_encrypted_args: Boolean(args_encrypted) };
}

// Arg keys that are secret-ish and must never be shown to a client, even in
// the "redacted" view. Matches the conventions already used for provider keys
// / MCP auth headers elsewhere in the codebase.
// Exported (Packet 1.1) so durable memory reuses the SAME heuristic rather than
// keeping a second, drifting copy — lib/agent/memory.ts refuses to persist a
// fact matching it. Read-only use: no /g flag, so there is no shared lastIndex.
export const SECRET_KEY_PATTERN = /token|password|api[_-]?key|secret|authorization|^key$/i;

/** Redact obvious secret-ish keys from a proposal's args for safe display.
 * Shallow + one level of nested objects/arrays — proposal args are simple
 * tool-call payloads, not arbitrary deep structures. */
export function redactArgs(args: Record<string, any>): Record<string, any> {
  const redactValue = (v: any): any => {
    if (Array.isArray(v)) return v.map(redactValue);
    if (v && typeof v === 'object') return redactObject(v);
    return v;
  };
  const redactObject = (obj: Record<string, any>): Record<string, any> => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = SECRET_KEY_PATTERN.test(k) ? '[redacted]' : redactValue(v);
    }
    return out;
  };
  return redactObject(args || {});
}

/** Canonical sha256 of args — sorted keys at every level so key-order
 * differences never cause spurious edit-invalidation. */
export function hashArgs(args: Record<string, any>): string {
  const sortDeep = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      const out: Record<string, any> = {};
      for (const k of Object.keys(v).sort()) out[k] = sortDeep(v[k]);
      return out;
    }
    return v;
  };
  return createHash('sha256').update(JSON.stringify(sortDeep(args || {}))).digest('hex');
}

// APPROVAL LIFETIME, per gate class.
//
// An approval is authority to do one specific thing. Authority that never
// lapses is not a gate: a user approves a $500 ad launch, the model fails
// before executing, and three weeks later a retry fires it against a budget
// and a campaign that no longer exist. The args hash catches a changed
// PAYLOAD; nothing caught a changed WORLD. This is that check.
//
// Scaled by how bad a stale execution is, not by how long a human might
// reasonably take: destructive is irreversible, spend and standing_rule commit
// money (a standing rule commits it repeatedly), external_send only reaches a
// third party once. Expiring is cheap — the user is asked again.
//
// read / internal_write never reach the approval path at all; they are listed
// so the record is total and a new gate class cannot silently inherit a
// default. Override with APPROVAL_TTL_MINUTES.
const TTL_MINUTES_ENV = Number(process.env.APPROVAL_TTL_MINUTES);
const DEFAULT_TTL_MINUTES: Record<GateClass, number> = {
  destructive: 15,
  spend: 30,
  standing_rule: 30,
  external_send: 60,
  read: 0,
  internal_write: 0,
};

/** ISO expiry for a proposal of this gate class, or null when it never lapses.
 *  An unknown/absent gate yields null — callers that do not declare a gate keep
 *  exactly their previous behaviour rather than inheriting a surprise TTL. */
export function expiryForGate(gate?: GateClass, now: Date = new Date()): string | null {
  if (!gate) return null;
  const mins = Number.isFinite(TTL_MINUTES_ENV) && TTL_MINUTES_ENV > 0
    ? TTL_MINUTES_ENV
    : DEFAULT_TTL_MINUTES[gate];
  if (!mins || mins <= 0) return null;
  return new Date(now.getTime() + mins * 60_000).toISOString();
}

/** True when `expiresAt` is set and already in the past. */
export function isPastDue(expiresAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t <= now.getTime();
}

export interface ApprovalProposalInput {
  tool: string;
  title: string;
  summary: string;
  args: Record<string, any>;
  conversationId?: string | null;
  requestedBy?: string | null;
  /** Gate class of the capability being proposed. Sets the default expiry.
   *  Omit and the approval never lapses (pre-expiry behaviour). */
  gate?: GateClass;
  /** Explicit override. Wins over the gate-derived default when supplied. */
  expiresAt?: string | null;
}

/** Persist a new pending approval from an agent proposal. Encrypts the full
 * args for later resume/audit (mirrors lib/mcp/clients.ts createMcpClient);
 * if the vault isn't configured, the row is still created WITHOUT
 * args_encrypted (redacted args + hash are still useful for the UI/audit
 * trail) rather than blocking the proposal from being surfaced at all. */
export async function createApproval(accountId: string, input: ApprovalProposalInput): Promise<SafeApproval> {
  const redacted = redactArgs(input.args);
  const hash = hashArgs(input.args);
  const row: Record<string, any> = {
    account_id: accountId,
    conversation_id: input.conversationId ?? null,
    tool: input.tool,
    title: input.title,
    summary: input.summary,
    args_redacted: redacted,
    args_hash: hash,
    state: 'pending',
    requested_by: input.requestedBy ?? null,
    expires_at: input.expiresAt ?? expiryForGate(input.gate),
  };
  if (vaultConfigured()) {
    row.args_encrypted = encryptSecret(JSON.stringify(input.args || {}));
  }
  const { data, error } = await supabase.from('approvals').insert([row]).select().single();
  if (error) throw error;
  return toSafe(data);
}

export interface AutomatedExecutionInput {
  tool: string;
  title: string;
  summary: string;
  args: Record<string, any>;
  /** e.g. 'automation:<social_automations.id>' — never a human email, so this
   * row is unambiguously distinguishable in the audit trail from a
   * human-approved send. */
  requestedBy: string;
}

/** Packet 7.3 — the automation runner's audit trail. Unlike createApproval
 * (always 'pending', waiting on a human decision), this writes a row that is
 * ALREADY terminal: the send already happened with no human in the loop, and
 * this row is the record of it, not a request for permission. Every
 * automated send must call this — an automated send that leaves no trace is
 * unacceptable (COPILOT_REMEDIATION_PLAN.md Packet 7.3). Best-effort by
 * design at the call site (the send cannot be undone if the audit write
 * fails), but callers must still log a failure, never swallow it silently. */
export async function recordExecutedApproval(accountId: string, input: AutomatedExecutionInput): Promise<SafeApproval> {
  const redacted = redactArgs(input.args);
  const hash = hashArgs(input.args);
  const row: Record<string, any> = {
    account_id: accountId,
    tool: input.tool,
    title: input.title,
    summary: input.summary,
    args_redacted: redacted,
    args_hash: hash,
    state: 'executed',
    requested_by: input.requestedBy,
    executed_at: new Date().toISOString(),
  };
  if (vaultConfigured()) {
    row.args_encrypted = encryptSecret(JSON.stringify(input.args || {}));
  }
  const { data, error } = await supabase.from('approvals').insert([row]).select().single();
  if (error) throw error;
  return toSafe(data);
}

/** Report what a row IS, not merely what was last written to it.
 *
 *  Nothing sweeps lapsed approvals — the flip to 'expired' happens lazily, on
 *  the decide or consume that notices. That is fine for enforcement (both paths
 *  check) but wrong for DISPLAY: a lapsed proposal would keep rendering as
 *  pending, with live Approve and Reject buttons whose only possible outcome is
 *  an error. Showing a dead card as actionable teaches people the buttons are
 *  unreliable.
 *
 *  So the read path resolves it. No sweeper, no migration, no UI change: the
 *  row still flips in the database the moment anyone acts on it. */
function withEffectiveState(row: SafeApproval): SafeApproval {
  if ((row.state === 'pending' || row.state === 'approved') && isPastDue(row.expires_at)) {
    return { ...row, state: 'expired' };
  }
  return row;
}

export async function listApprovals(accountId: string, opts?: { state?: ApprovalState }): Promise<SafeApproval[]> {
  let query = supabase.from('approvals').select('*').eq('account_id', accountId);
  if (opts?.state) query = query.eq('state', opts.state);
  const { data, error } = await query.order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []).map(toSafe).map(withEffectiveState);
}

/** The pending approval belonging to one conversation, if there is one.
 *
 *  WHY THIS EXISTS. An approval row is created BEFORE the needs_approval event
 *  is emitted, because execution is gated on that row. So the queue entry
 *  always exists, while the inline card only appears if the browser was still
 *  connected to receive the event — and a turn that threw, was stopped, or was
 *  navigated away from left the operator with a queue entry and no card, which
 *  reads as the assistant having silently rerouted their work.
 *
 *  Live work is now re-surfaced in the chat it came from. A SCHEDULED task has
 *  no conversation, so its approvals are unaffected and stay queue-only, which
 *  is exactly where they belong — nobody is watching a chat at 3am.
 */
export async function pendingApprovalForConversation(
  accountId: string,
  conversationId: string,
): Promise<SafeApproval | null> {
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .eq('state', 'pending')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  const row = (data || [])[0];
  if (!row) return null;
  const safe = withEffectiveState(toSafe(row));
  // withEffectiveState downgrades a lapsed proposal to 'expired'. Re-surfacing
  // one would offer a button that cannot work.
  return safe.state === 'pending' ? safe : null;
}

export async function getApproval(accountId: string, id: string): Promise<SafeApproval | null> {
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data ? withEffectiveState(toSafe(data)) : null;
}

/** Internal-only fetch including args_encrypted, for the resume path. Never
 * expose this row directly over the API. */
async function getApprovalRaw(accountId: string, id: string): Promise<ApprovalRow | null> {
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/** Decrypt the stored args for exactly one resume/execution. Never logged,
 * never returned to a client — see lib/ai/crypto.ts. */
export async function decryptApprovalArgs(accountId: string, id: string): Promise<Record<string, any> | null> {
  const raw = await getApprovalRaw(accountId, id);
  if (!raw || !raw.args_encrypted) return null;
  return JSON.parse(decryptSecret(raw.args_encrypted));
}

export class ApprovalDecisionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Decide (approve/reject) a pending approval. Enforces:
 *  (i)  NO-SELF-APPROVAL — decidedBy must differ from the stored requested_by
 *       (when requested_by is known); refuses otherwise with a clear error.
 *  (ii) EDIT-INVALIDATES — if currentArgs is supplied and its canonical hash
 *       no longer matches the stored args_hash, the row is flipped to
 *       'invalidated' and the decision is refused (the proposal changed
 *       since it was raised, so the old approval can't be trusted).
 *  (iii) Only a 'pending' row can be decided — anything else (already
 *        decided/expired/invalidated) is refused.
 */
export async function decideApproval(
  accountId: string,
  id: string,
  decision: 'approved' | 'rejected',
  actor: { decidedBy: string; comment?: string | null },
  currentArgs?: Record<string, any>,
): Promise<SafeApproval> {
  const existing = await getApprovalRaw(accountId, id);
  if (!existing) throw new ApprovalDecisionError('not_found', 'Unknown approval');

  if (existing.state !== 'pending') {
    throw new ApprovalDecisionError('not_pending', `This approval is already ${existing.state} and can no longer be decided.`);
  }

  // A pending row that lapsed cannot be approved into life. Rejecting one is
  // harmless, but it is still dead, so flip it and refuse either way rather
  // than handing back an approval that consume would immediately expire.
  if (isPastDue(existing.expires_at)) {
    await supabase
      .from('approvals')
      .update({ state: 'expired', updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', accountId)
      .eq('state', 'pending');
    throw new ApprovalDecisionError('not_pending', 'This request lapsed before it was reviewed. Ask the agent to propose it again.');
  }

  if (existing.requested_by && existing.requested_by === actor.decidedBy) {
    throw new ApprovalDecisionError('self_approval', 'You cannot approve or reject your own proposal — ask another operator to review it.');
  }

  if (currentArgs !== undefined) {
    const currentHash = hashArgs(currentArgs);
    if (currentHash !== existing.args_hash) {
      await supabase
        .from('approvals')
        .update({ state: 'invalidated', updated_at: new Date().toISOString() })
        .eq('id', id)
        .eq('account_id', accountId);
      throw new ApprovalDecisionError('invalidated', 'This proposal changed since it was raised and can no longer be approved as-is. Ask the agent to re-propose it.');
    }
  }

  const { data, error } = await supabase
    .from('approvals')
    .update({
      state: decision,
      decided_by: actor.decidedBy,
      decided_at: new Date().toISOString(),
      comment: actor.comment ?? null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', accountId)
    .eq('state', 'pending') // belt-and-suspenders against a race with another decider
    .select()
    .single();
  if (error) throw error;
  if (!data) throw new ApprovalDecisionError('not_pending', 'This approval was just decided by someone else.');
  return toSafe(data);
}

/** Best-effort: mark a pending approval 'approved' by matching tool+args_hash
 * for this account. Used opportunistically from the resume path in
 * lib/agent/loop.ts — failures must never block execution, so callers should
 * wrap this in try/catch and ignore errors. */
export async function markApprovedByToolAndArgs(
  accountId: string,
  tool: string,
  args: Record<string, any>,
  decidedBy?: string | null,
): Promise<void> {
  const hash = hashArgs(args);
  await supabase
    .from('approvals')
    .update({ state: 'approved', decided_by: decidedBy ?? null, decided_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('account_id', accountId)
    .eq('tool', tool)
    .eq('args_hash', hash)
    .eq('state', 'pending');
}

export class ApprovalExecutionError extends Error {
  constructor(
    public code: 'not_found' | 'not_approved' | 'args_mismatch' | 'already_executed' | 'expired',
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalExecutionError';
  }
}

/**
 * Unlike `markApprovedByToolAndArgs` (best-effort, fire-and-forget), this is the
 * authoritative execution gate. Any failure here MUST propagate so the caller
 * refuses to execute the sensitive tool.
 *
 * Atomically consume an approved approval so a sensitive tool may run ONCE.
 * Rejects with `ApprovalExecutionError`:
 * - 'not_found'       no row for this approval id + account
 * - 'args_mismatch'   tool or args_hash does not match the requested execution
 * - 'already_executed' this approval was already consumed
 * - 'not_approved'    the approval is pending/rejected/invalidated/expired
 */
export async function consumeApprovalForExecution(
  accountId: string,
  approvalId: string,
  tool: string,
  args: Record<string, any>,
): Promise<void> {
  // Scoped fetch: the approval row must belong to this account.
  const { data: row, error: fetchError } = await supabase
    .from('approvals')
    .select('id, tool, args_hash, state, expires_at')
    .eq('id', approvalId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (fetchError) throw fetchError;
  if (!row) {
    throw new ApprovalExecutionError('not_found', 'Unknown approval');
  }

  // The exact tool and args must match what was approved. If args changed after
  // approval, hashArgs(args) will differ and invalidation/refusal bites here.
  if (row.tool !== tool || row.args_hash !== hashArgs(args)) {
    throw new ApprovalExecutionError(
      'args_mismatch',
      'Approval does not match the requested tool and arguments.',
    );
  }

  if (row.state === 'executed') {
    throw new ApprovalExecutionError(
      'already_executed',
      'This approval has already been consumed.',
    );
  }

  // EXPIRY. Checked after 'executed' (that is the more precise answer for a
  // row that already ran) and before 'not_approved', because a lapsed row is
  // still sitting in state 'approved' — nothing sweeps it. The flip to
  // 'expired' happens here, on the read that noticed, so the audit trail shows
  // why it did not run and a second attempt gets the same verdict cheaply.
  //
  // Conditioned on state='approved' so this can never overwrite a terminal
  // 'executed' row if two callers race.
  if (isPastDue(row.expires_at)) {
    await supabase
      .from('approvals')
      .update({ state: 'expired', updated_at: new Date().toISOString() })
      .eq('id', approvalId)
      .eq('account_id', accountId)
      .eq('state', 'approved');
    throw new ApprovalExecutionError(
      'expired',
      'This approval lapsed before it was carried out.',
    );
  }

  if (row.state !== 'approved') {
    throw new ApprovalExecutionError(
      'not_approved',
      `This approval is ${row.state} and cannot be executed.`,
    );
  }

  // Atomic consume: the state-conditioned UPDATE is the guard. If another caller
  // consumes it first, zero rows are returned and we treat it as already executed.
  const { data: consumed, error: updateError } = await supabase
    .from('approvals')
    .update({
      state: 'executed',
      executed_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', approvalId)
    .eq('account_id', accountId)
    .eq('state', 'approved') // single-use guard in the query, not in JS
    .select('id')
    .maybeSingle();
  if (updateError) throw updateError;
  if (!consumed) {
    throw new ApprovalExecutionError(
      'already_executed',
      'This approval was just consumed by another execution.',
    );
  }
}
