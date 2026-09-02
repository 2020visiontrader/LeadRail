// Per-message thumbs up/down (migration 080_message_feedback.sql).
//
// See that migration's header for the full design. skill_slugs now HAS a
// writer: lib/agent/loop.ts exposes the turn's routed skill slugs on
// AgentResult (non-streaming) and the streaming 'final' event, both API
// routes (app/api/agent/route.ts, app/api/agent/stream/route.ts) hand them to
// the client alongside lastMessageId, and AgentConsole.tsx forwards them back
// on a vote — recordMessageFeedback below is where they land. Same
// reliability caveat as persona_id: real for a turn the client just
// completed this session, null for a rehydrated (post-reload) turn nothing
// re-fetches it for. This file is the one place that writes and reads the
// table; account scoping is applied INSIDE every query here, never trusted
// from a caller, same discipline as lib/documents/attachment-bindings.ts.

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
  /** Routed skill slugs for the turn that produced this message (migration
   *  080's message_feedback.skill_slugs writer — see lib/agent/loop.ts's
   *  AgentResult.skillSlugs / the streaming 'final' event, threaded through
   *  the feedback route). Same reliability caveat as personaId: real when the
   *  console has it (a turn just completed this session), null on a
   *  rehydrated turn the client never re-fetches it for. NOT trusted as an
   *  authorization value — it is a snapshot of routing metadata only. */
  skillSlugs?: string[] | null;
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
          skill_slugs: args.skillSlugs && args.skillSlugs.length ? args.skillSlugs : null,
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
