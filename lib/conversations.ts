// ============================================================
// Phase D #14 — unified conversations. A channel-agnostic thread model that
// generalizes inbox_messages (email today; sms/social/whatsapp later).
// inbox_messages remains the email ingest source; conversations mirror it plus
// outbound sends so a contact's full two-sided history lives in one place.
// ============================================================
import { supabase } from '@/lib/db';

export async function listConversations(accountId: string, limit = 50) {
  const { data, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .order('last_message_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

export async function getConversation(id: string, accountId: string) {
  const { data: conv, error } = await supabase
    .from('conversations').select('*').eq('id', id).eq('account_id', accountId).maybeSingle();
  if (error) throw error;
  if (!conv) return null;
  const { data: messages } = await supabase
    .from('conversation_messages')
    .select('*')
    .eq('conversation_id', id)
    .eq('account_id', accountId)
    .order('sent_at', { ascending: true });
  return { ...conv, messages: messages || [] };
}

export async function markConversationRead(id: string, accountId: string, isRead = true) {
  const { data, error } = await supabase
    .from('conversations')
    .update({ unread_count: isRead ? 0 : 1, updated_at: new Date().toISOString() })
    .eq('id', id).eq('account_id', accountId).select().single();
  if (error) throw error;
  if (isRead) {
    await supabase.from('conversation_messages').update({ is_read: true })
      .eq('conversation_id', id).eq('account_id', accountId).then(() => {}, () => {});
  }
  return data;
}

export async function setConversationStatus(id: string, accountId: string, status: string) {
  const allowed = ['open', 'closed', 'snoozed'];
  if (!allowed.includes(status)) throw new Error('invalid status');
  const { data, error } = await supabase
    .from('conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id).eq('account_id', accountId).select().single();
  if (error) throw error;
  return data;
}

export interface ConversationMessageInput {
  accountId: string;
  contactId?: string | null;
  channel?: string;                 // default 'email'
  direction?: 'inbound' | 'outbound';
  threadKey?: string | null;        // provider thread id; falls back to contact, then random
  fromAddr?: string | null;
  toAddr?: string | null;
  subject?: string | null;
  body?: string | null;
  externalId?: string | null;       // provider msg id for dedup
  meta?: Record<string, any>;
}

/**
 * Find-or-create the conversation for a thread and append a message. Idempotent
 * on externalId (dedup). Best-effort — never throws into the send/ingest path.
 */
export async function recordConversationMessage(input: ConversationMessageInput): Promise<void> {
  const {
    accountId, contactId = null, channel = 'email', direction = 'inbound',
    fromAddr = null, toAddr = null, subject = null, body = null, externalId = null, meta = {},
  } = input;
  if (!accountId) return;
  const threadKey = input.threadKey || (contactId ? `contact:${contactId}` : `msg:${externalId || crypto.randomUUID()}`);
  try {
    // Dedup: if this external message is already recorded, stop.
    if (externalId) {
      const { data: dup } = await supabase
        .from('conversation_messages').select('id')
        .eq('account_id', accountId).eq('channel', channel).eq('external_id', externalId).limit(1);
      if (dup?.length) return;
    }
    // Find-or-create conversation.
    let convId: string | null = null;
    const { data: existing } = await supabase
      .from('conversations').select('id')
      .eq('account_id', accountId).eq('channel', channel).eq('external_thread_id', threadKey).limit(1);
    if (existing?.length) {
      convId = existing[0].id;
    } else {
      const { data: created } = await supabase.from('conversations').insert([{
        account_id: accountId, contact_id: contactId, channel, external_thread_id: threadKey,
        subject, last_direction: direction, last_message_at: new Date().toISOString(),
        unread_count: direction === 'inbound' ? 1 : 0,
      }]).select('id').single();
      convId = created?.id || null;
    }
    if (!convId) return;
    await supabase.from('conversation_messages').insert([{
      account_id: accountId, conversation_id: convId, contact_id: contactId, channel, direction,
      from_addr: fromAddr, to_addr: toAddr, subject, body, external_id: externalId,
      meta, is_read: direction === 'outbound', sent_at: new Date().toISOString(),
    }]);
    // Bump the conversation head. For inbound, increment unread via read-modify-write.
    const head: Record<string, any> = {
      last_direction: direction,
      last_message_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (direction === 'inbound') {
      const { data: c } = await supabase.from('conversations').select('unread_count').eq('id', convId).single();
      head.unread_count = (c?.unread_count || 0) + 1;
    }
    await supabase.from('conversations').update(head).eq('id', convId).then(() => {}, () => {});
  } catch {
    // conversations table absent (012 unapplied) or transient — swallow
  }
}
