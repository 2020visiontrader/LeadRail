// ============================================================
// Inbound email ingest — the RECEIVE path for inbox_messages.
// inbox_messages is the email ingest source of truth (migration 004);
// conversations/conversation_messages (migration 012) mirror it for the
// channel-agnostic thread UI. This module is the only writer of inbound rows
// into inbox_messages — nothing else in the codebase inserts into it.
// ============================================================
import { supabase } from '@/lib/db';
import { findContactByEmail } from '@/lib/db';
import { recordConversationMessage } from '@/lib/conversations';

export interface InboundEmailPayload {
  from: string;
  to: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
  thread?: string | null;
}

export type IngestResult =
  | { ignored: true; reason: string }
  | { ingested: true; accountId: string; messageId: string | null };

/** Minimal HTML → text fallback for providers that only send `html`. */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Ingest one inbound email: resolve the owning account from the recipient
 * address, insert the source-of-truth inbox_messages row, then best-effort
 * mirror it into the unified conversations model. Never throws — a mapping
 * miss or a mirror failure both return/degrade gracefully so a webhook
 * caller never sees a 500 for a message that simply isn't ours to route.
 */
export async function ingestInboundEmail(payload: InboundEmailPayload): Promise<IngestResult> {
  const from = String(payload.from || '').trim();
  const to = String(payload.to || '').trim();
  if (!from || !to) return { ignored: true, reason: 'missing_from_or_to' };

  // Multi-recipient: `to` may be a comma-separated list: use the first address
  // that maps to one of our accounts.
  const toCandidates = to
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean);

  let accountId: string | null = null;
  let matchedTo: string | null = null;
  for (const candidate of toCandidates) {
    const { data } = await supabase
      .from('email_accounts')
      .select('account_id')
      .ilike('address', candidate)
      .limit(1);
    if (data && data.length) {
      accountId = data[0].account_id;
      matchedTo = candidate;
      break;
    }
  }
  if (!accountId) return { ignored: true, reason: 'no_mapping' };

  const contact = await findContactByEmail(from, accountId).catch(() => null);
  const contactId = contact?.id || null;

  const messageId = payload.messageId ? String(payload.messageId).trim() : null;
  const threadKey =
    (payload.thread && String(payload.thread).trim()) ||
    (payload.inReplyTo && String(payload.inReplyTo).trim()) ||
    (messageId ? `msg:${messageId}` : `msg:${crypto.randomUUID()}`);

  const subject = payload.subject ?? null;
  const body = payload.text || (payload.html ? stripHtml(payload.html) : null);
  const nowIso = new Date().toISOString();

  const { error: insertError } = await supabase.from('inbox_messages').insert([
    {
      account_id: accountId,
      contact_id: contactId,
      thread_id: threadKey,
      direction: 'inbound',
      from_addr: from,
      to_addr: matchedTo || to,
      subject,
      body,
      is_read: false,
      received_at: nowIso,
    },
  ]);
  if (insertError) throw insertError;

  // Best-effort mirror into the unified conversations model — replicates the
  // find-or-create-conversation + append-message pattern from migration
  // 012's backfill DO-block. Never throw: inbox_messages above is already the
  // source of truth and must not be rolled back by a mirror failure.
  try {
    await recordConversationMessage({
      accountId,
      contactId,
      channel: 'email',
      direction: 'inbound',
      threadKey,
      fromAddr: from,
      toAddr: matchedTo || to,
      subject,
      body,
      externalId: messageId ? `msg:${messageId}` : null,
    });
  } catch {
    // swallow — best-effort mirror only
  }

  return { ingested: true, accountId, messageId };
}
