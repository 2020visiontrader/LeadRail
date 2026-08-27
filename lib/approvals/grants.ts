// Session-scoped standing approvals (migration 062).
//
// The third answer to an approval card. Today there are two — approve this one
// call, or reject it — and for a per-item tool that is the wrong shape: the
// operator said "pull fifty" once, and then got asked fifty times. Production
// bears it out: 29 enrichLead approvals, three of which lapsed unanswered.
//
// THE BOUNDS ARE THE FEATURE, not a hedge around it:
//   - per TOOL       approving enrichLead says nothing about sendEmail
//   - per CONVERSATION  the grant cannot outlive the session it was given in
//   - use-capped     "fifty" means fifty
//   - time-limited   expires with or before the conversation
//   - revocable      revoked_at cuts it immediately
//   - audited        every covered call still writes an approvals row
//
// A grant relaxes WHO IS ASKED, never WHAT IS ALLOWED. The monthly spend gate
// in runTool, argument validation, and account scoping all still apply exactly
// as they do to a hand-approved call.

import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';
import type { GateClass } from '@/lib/capabilities/types';

/** Hard ceiling on one grant, regardless of what was asked for. A standing
 *  permission that cannot be exhausted is not a permission, it is a mode. */
export const MAX_GRANT_USES = Number(process.env.APPROVAL_GRANT_MAX_USES) || 100;
/** How long a grant may live. Short by design: it is meant to cover the batch
 *  in front of you, not the afternoon. */
export const GRANT_TTL_MS = Number(process.env.APPROVAL_GRANT_TTL_MS) || 2 * 60 * 60 * 1000;

/**
 * Which gate classes may be covered by a standing grant.
 *
 * `spend` and `external_send` are the repetitive ones — enriching a pool,
 * emailing a list — where being asked per item is friction with no safety
 * benefit, because the operator already made the decision at batch scale.
 *
 * `destructive` and `standing_rule` are excluded, and not out of caution for
 * its own sake. Deleting is not something anyone legitimately does fifty times
 * in a row, so a standing grant buys no ergonomics there while removing the one
 * checkpoint before an irreversible action. And `standing_rule` creates a rule
 * that later runs WITHOUT a human — a blanket approval to create unattended
 * rules compounds in exactly the way a single wrong autonomous action does not.
 *
 * If this line turns out to be wrong it is one array to change, and the reason
 * it is drawn here is written down rather than implied.
 */
export const GRANTABLE_GATES: GateClass[] = ['spend', 'external_send'];

export function isGrantable(gate: GateClass | undefined): boolean {
  return Boolean(gate && GRANTABLE_GATES.includes(gate));
}

export interface GrantRow {
  id: string;
  tool: string;
  conversationId: string;
  usesRemaining: number;
  expiresAt: string;
  grantedBy: string | null;
  revokedAt: string | null;
}

function toGrant(r: any): GrantRow {
  return {
    id: r.id,
    tool: r.tool,
    conversationId: r.conversation_id,
    usesRemaining: r.uses_remaining,
    expiresAt: r.expires_at,
    grantedBy: r.granted_by ?? null,
    revokedAt: r.revoked_at ?? null,
  };
}

/**
 * Create a standing grant for one tool in one conversation.
 *
 * `uses` is clamped rather than rejected: an operator who asks for 500 gets
 * MAX_GRANT_USES and a grant that works, not an error on the button they just
 * pressed. The clamp is reported back so the UI can say what was actually
 * given.
 */
export async function createGrant(args: {
  accountId: string;
  conversationId: string;
  tool: string;
  uses: number;
  grantedBy?: string | null;
  ttlMs?: number;
}): Promise<{ grant: GrantRow | null; clampedTo?: number }> {
  const requested = Math.trunc(args.uses);
  if (!Number.isFinite(requested) || requested < 1) return { grant: null };
  const uses = Math.min(requested, MAX_GRANT_USES);
  const expires = new Date(Date.now() + (args.ttlMs ?? GRANT_TTL_MS)).toISOString();

  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .insert([{
        account_id: args.accountId,
        conversation_id: args.conversationId,
        tool: args.tool,
        uses_remaining: uses,
        expires_at: expires,
        granted_by: args.grantedBy ?? null,
      }])
      .select()
      .single();
    if (error || !data) return { grant: null };
    // Worth a persisted line: this is the moment a human widened what runs
    // unattended, and it should be as reviewable as the actions it covers.
    log.info('approval: standing grant created', {
      accountId: args.accountId, tool: args.tool,
      conversationId: args.conversationId, uses, actorEmail: args.grantedBy ?? undefined,
    });
    return { grant: toGrant(data), ...(uses < requested ? { clampedTo: uses } : {}) };
  } catch {
    return { grant: null };
  }
}

/**
 * Claim one use of a live grant, atomically.
 *
 * Returns null when nothing applies — no grant, exhausted, expired, revoked, or
 * the DB is unreachable. Every one of those means the same thing to the caller:
 * fall through and raise a normal approval card. Failing CLOSED is the only
 * acceptable direction here, because the failure mode in the other direction is
 * spending money nobody approved.
 */
export async function consumeGrant(
  accountId: string,
  conversationId: string | null | undefined,
  tool: string,
): Promise<{ grantId: string; usesLeft: number } | null> {
  if (!conversationId) return null;
  try {
    const { data, error } = await supabase.rpc('consume_approval_grant', {
      p_account: accountId,
      p_conversation: conversationId,
      p_tool: tool,
    });
    if (error) return null;
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || row.grant_id == null) return null;
    return { grantId: row.grant_id, usesLeft: Number(row.uses_left ?? 0) };
  } catch {
    return null;
  }
}

/** Live grants for a conversation, so a UI (or the assistant) can say what is
 *  currently standing. */
export async function listGrants(accountId: string, conversationId: string): Promise<GrantRow[]> {
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .select('*')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .is('revoked_at', null)
      .gt('uses_remaining', 0)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(toGrant);
  } catch {
    return [];
  }
}

/** Every live grant on the account, newest first, with the conversation each
 *  belongs to.
 *
 *  Account-scoped rather than conversation-scoped on purpose. The turn-local
 *  context in lib/capabilities/delegation.ts is a MODULE-LEVEL mutable, and
 *  this process serves every tenant with turns interleaving freely — the exact
 *  hazard lib/ai/usage.ts documents. Reading a permission scope through that
 *  could show or revoke the wrong conversation's grants. `accountId` arrives as
 *  a trusted argument, so scoping here instead is both safer and more useful:
 *  "what am I currently letting it do?" is an account-level question. */
export async function listLiveGrantsForAccount(accountId: string): Promise<GrantRow[]> {
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .select('*')
      .eq('account_id', accountId)
      .is('revoked_at', null)
      .gt('uses_remaining', 0)
      .gt('expires_at', new Date().toISOString())
      .order('created_at', { ascending: false });
    if (error || !Array.isArray(data)) return [];
    return data.map(toGrant);
  } catch {
    return [];
  }
}

/** Revoke every live grant on the account — the unconditional "stop". */
export async function revokeAllForAccount(accountId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .is('revoked_at', null)
      .select('id');
    if (error || !Array.isArray(data)) return 0;
    return data.length;
  } catch {
    return 0;
  }
}

/** Revoke immediately. Scoped by account so one tenant cannot revoke another's,
 *  and idempotent — revoking an already-revoked grant is not an error. */
export async function revokeGrant(accountId: string, grantId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('id', grantId)
      .is('revoked_at', null)
      .select('id');
    if (error) return false;
    return Array.isArray(data) && data.length > 0;
  } catch {
    return false;
  }
}

/** Revoke every live grant in a conversation — the "stop, ask me again" button. */
export async function revokeAllForConversation(accountId: string, conversationId: string): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('approval_grants')
      .update({ revoked_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .is('revoked_at', null)
      .select('id');
    if (error || !Array.isArray(data)) return 0;
    return data.length;
  } catch {
    return 0;
  }
}
