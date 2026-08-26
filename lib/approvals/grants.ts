// "Allow for this chat" — a bounded standing approval.
//
// WHY THIS IS NOT JUST A TOGGLE. Approving twenty identical reveals one at a
// time is not a control, it is a reflex. Nobody reads the twentieth card, so
// the single-use-only design was buying less safety than it appeared to: the
// gate was still there, but the reading had stopped.
//
// The fix is not an unlimited "always" either. A grant that never runs out,
// never expires and covers the whole account is a blank cheque on capabilities
// that spend money — exactly what the gate exists to prevent. So a grant is
// bounded three ways, and each bound answers a specific way an unbounded one
// goes wrong:
//
//   scope   -> the conversation it was granted in. "Yes, reveal these leads"
//              must not license a reveal in a chat opened next week.
//   uses    -> finite and countable. The person authorised an amount of work,
//              not an open tap.
//   expiry  -> a grant forgotten about stops applying by itself.
//
// And every execution under a grant still writes an audit row. An action that
// runs with no human in the loop and leaves no trace is the failure this whole
// subsystem exists to avoid; a grant changes WHO authorised something and WHEN,
// never whether it is recorded.

import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';

/** Default size of a grant. Big enough to cover a working session without
 *  re-asking, small enough that a person can picture it — "the next 25 of
 *  these" is a decision; "all of them, forever" is not. */
export const DEFAULT_GRANT_USES = Number(process.env.APPROVAL_GRANT_USES) || 25;

/** How long a grant lives regardless of use. Scoped to a working session, not
 *  a day: coming back tomorrow to a chat that still auto-approves spend is a
 *  surprise, and surprises are what a spend gate must never produce. */
export const DEFAULT_GRANT_MINUTES = Number(process.env.APPROVAL_GRANT_MINUTES) || 120;

export interface GrantRow {
  id: string;
  account_id: string;
  conversation_id: string;
  tool: string;
  granted_by: string | null;
  uses_remaining: number;
  expires_at: string;
  revoked_at: string | null;
}

/** Record a standing grant. Returns null (never throws) on failure — a grant
 *  that could not be stored simply means the next call asks again, which is the
 *  safe direction to fail in. */
export async function grantStandingApproval(input: {
  accountId: string;
  conversationId: string;
  tool: string;
  grantedBy?: string | null;
  uses?: number;
  minutes?: number;
}): Promise<GrantRow | null> {
  const uses = Math.max(1, Math.min(input.uses ?? DEFAULT_GRANT_USES, 200));
  const minutes = Math.max(1, Math.min(input.minutes ?? DEFAULT_GRANT_MINUTES, 24 * 60));
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .insert([{
        account_id: input.accountId,
        conversation_id: input.conversationId,
        tool: input.tool,
        granted_by: input.grantedBy ?? null,
        uses_remaining: uses,
        expires_at: new Date(Date.now() + minutes * 60_000).toISOString(),
      }])
      .select()
      .single();
    if (error) throw error;
    log.info('approval grant created', { tool: input.tool, uses, minutes, conversationId: input.conversationId });
    return data as GrantRow;
  } catch (e) {
    log.error('approval grant: could not store', e, { tool: input.tool });
    return null;
  }
}

/**
 * Spend one use of a live grant for this tool, if there is one.
 *
 * Returns the grant id when a use was consumed, null when there is no grant to
 * use. Null is the ONLY safe default: every failure path here — no row, expired,
 * exhausted, revoked, a database error — returns null, so the caller falls back
 * to asking a human. A bug in this function can make the product ask too often.
 * It must never be able to make it ask too little.
 *
 * The decrement is conditioned in the query rather than read-then-written, so
 * two concurrent calls cannot both spend the last use.
 */
export async function consumeGrant(
  accountId: string,
  conversationId: string | undefined,
  tool: string,
): Promise<string | null> {
  if (!conversationId) return null;
  try {
    const nowIso = new Date().toISOString();
    const { data: rows, error } = await supabase
      .from('approval_grants')
      .select('id, uses_remaining')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .eq('tool', tool)
      .is('revoked_at', null)
      .gt('uses_remaining', 0)
      .gt('expires_at', nowIso)
      .order('created_at', { ascending: true })
      .limit(1);
    if (error) throw error;

    const row = (rows || [])[0] as { id: string; uses_remaining: number } | undefined;
    if (!row) return null;

    // Conditioned on the count we read: if another call spent it first, this
    // matches zero rows and we ask a human rather than double-spending.
    const { data: updated, error: upErr } = await supabase
      .from('approval_grants')
      .update({ uses_remaining: row.uses_remaining - 1, updated_at: nowIso })
      .eq('id', row.id)
      .eq('uses_remaining', row.uses_remaining)
      .select('id')
      .maybeSingle();
    if (upErr) throw upErr;
    if (!updated) return null;

    return row.id;
  } catch (e) {
    log.error('approval grant: lookup failed, falling back to asking', e, { tool });
    return null;
  }
}

/** Live grants for a conversation, so the UI can show what is standing and
 *  offer to take it back. A person who granted something must be able to see
 *  that they did. */
export async function listGrants(accountId: string, conversationId: string): Promise<GrantRow[]> {
  const { data, error } = await supabase
    .from('approval_grants')
    .select('*')
    .eq('account_id', accountId)
    .eq('conversation_id', conversationId)
    .is('revoked_at', null)
    .gt('uses_remaining', 0)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data || []) as GrantRow[];
}

/** Take a grant back. Immediate — the next call asks again. */
export async function revokeGrant(accountId: string, id: string): Promise<void> {
  const { error } = await supabase
    .from('approval_grants')
    .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('account_id', accountId);
  if (error) throw error;
}
