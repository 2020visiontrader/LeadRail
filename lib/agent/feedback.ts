// Per-message thumbs up/down (migration 080_message_feedback.sql).
//
// See that migration's header for the full design and for exactly which
// columns are reliably populated (persona_id, model_label) versus reserved
// for a future writer (skill_slugs — see attachment_evidence, 076, for the
// precedent this follows). This file is the one place that writes and reads
// the table; account scoping is applied INSIDE every query here, never
// trusted from a caller, same discipline as lib/documents/attachment-bindings.ts.

import { supabase } from '@/lib/db';
import { log } from '@/lib/logger';

export interface MessageFeedback {
  id: string;
  accountId: string;
  conversationId: string;
  messageId: string;
  up: boolean;
  personaId: string | null;
  modelLabel: string | null;
  skillSlugs: string[] | null;
  updatedAt: string;
}

function toFeedback(r: any): MessageFeedback {
  return {
    id: r.id,
    accountId: r.account_id,
    conversationId: r.conversation_id,
    messageId: r.message_id,
    up: r.up,
    personaId: r.persona_id ?? null,
    modelLabel: r.model_label ?? null,
    skillSlugs: r.skill_slugs ?? null,
    updatedAt: r.updated_at,
  };
}

/**
 * Best-effort snapshot of ai_usage.model_label for this conversation, at or
 * before `atOrBefore` (defaults to now). Approximate at conversation
 * granularity — see the migration header for why a message-level join isn't
 * available. Never throws; a failed lookup just means model_label stays NULL,
 * which is honest (unknown), not a fabricated value.
 */
async function snapshotModelLabel(accountId: string, conversationId: string, atOrBefore?: string): Promise<string | null> {
  try {
    let q = supabase
      .from('ai_usage')
      .select('model_label, created_at')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId)
      .not('model_label', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1);
    if (atOrBefore) q = q.lte('created_at', atOrBefore);
    const { data, error } = await q.maybeSingle();
    if (error || !data) return null;
    return (data as any).model_label ?? null;
  } catch {
    return null;
  }
}

/**
 * Record (or change) a vote on a message. One row per (account, message) —
 * enforced by uniq_message_feedback_vote — so flipping a vote is an UPDATE,
 * never a second row. account_id, conversation_id and message_id must all be
 * supplied by the caller from trusted context (the session, and a
 * conversation the session already loaded) — this function does not verify
 * conversation ownership itself; see the route for that check.
 */
export async function recordMessageFeedback(args: {
  accountId: string;
  conversationId: string;
  messageId: string;
  up: boolean;
  personaId?: string | null;
  votedBy?: string | null;
}): Promise<MessageFeedback | null> {
  const modelLabel = await snapshotModelLabel(args.accountId, args.conversationId);
  try {
    const { data, error } = await supabase
      .from('message_feedback')
      .upsert(
        [{
          account_id: args.accountId,
          conversation_id: args.conversationId,
          message_id: args.messageId,
          up: args.up,
          persona_id: args.personaId ?? null,
          model_label: modelLabel,
          voted_by: args.votedBy ?? null,
          updated_at: new Date().toISOString(),
        }],
        { onConflict: 'account_id,message_id' },
      )
      .select()
      .maybeSingle();
    if (error || !data) {
      log.error('recordMessageFeedback: write failed', error, { conversationId: args.conversationId, messageId: args.messageId });
      return null;
    }
    return toFeedback(data);
  } catch (e) {
    log.error('recordMessageFeedback: threw', e, { conversationId: args.conversationId, messageId: args.messageId });
    return null;
  }
}

/** Every vote this account has cast in one conversation, keyed by message_id
 *  — the shape the console wants to paint existing votes on reload. */
export async function listFeedbackForConversation(accountId: string, conversationId: string): Promise<Record<string, MessageFeedback>> {
  try {
    const { data, error } = await supabase
      .from('message_feedback')
      .select('*')
      .eq('account_id', accountId)
      .eq('conversation_id', conversationId);
    if (error || !Array.isArray(data)) return {};
    const out: Record<string, MessageFeedback> = {};
    for (const row of data) out[row.message_id] = toFeedback(row);
    return out;
  } catch {
    return {};
  }
}
