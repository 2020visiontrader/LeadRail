// ============================================================
// Inbox reply-send — the SEND path for a reply from the LeadRail inbox.
// Two properties the outreach-send path (`lib/outreach.ts` /
// sendOutreachEmail) doesn't give us:
//   (a) sends FROM the exact @leadrail.xyz address the original message
//       arrived at, so the thread stays consistent for the recipient.
//   (b) works for senders with NO linked contact — outreach requires a
//       contactId and logs an email_campaigns row; a raw inbound reply is
//       neither of those things.
// Uses sendPlatformEmail (LeadRail's own leadrail.xyz Resend account) —
// deliberately NOT sendOutreachEmail/sendResendEmail.
// ============================================================
import { supabase } from '@/lib/db';
import { sendPlatformEmail } from '@/lib/integrations/resend';
import { recordConversationMessage } from '@/lib/conversations';

export interface SendInboxReplyInput {
  accountId: string;
  inboxMessageId: string;
  subject: string;
  bodyHtml: string;
}

export interface SendInboxReplyResult {
  sent: true;
  providerId: string | null;
  from: string;
  to: string;
}

/**
 * Send a reply to an inbox_messages row, from the exact address it arrived
 * at, to whoever sent it — regardless of whether it has a linked contact.
 */
export async function sendInboxReply({
  accountId,
  inboxMessageId,
  subject,
  bodyHtml,
}: SendInboxReplyInput): Promise<SendInboxReplyResult> {
  const { data: row, error: loadError } = await supabase
    .from('inbox_messages')
    .select('*')
    .eq('id', inboxMessageId)
    .eq('account_id', accountId)
    .maybeSingle();
  if (loadError) throw loadError;
  if (!row) throw new Error('Inbox message not found');

  const to = String(row.from_addr || '').trim();
  const fromAddr = String(row.to_addr || '').trim();
  if (!to) throw new Error('Original message has no from_addr to reply to');
  if (!fromAddr) throw new Error('Original message has no to_addr to reply from');

  // SECURITY: only allow sending from an address this account actually owns —
  // otherwise a caller could reply "from" an arbitrary spoofed address.
  const { data: owned, error: ownedError } = await supabase
    .from('email_accounts')
    .select('id')
    .eq('account_id', accountId)
    .ilike('address', fromAddr)
    .limit(1);
  if (ownedError) throw ownedError;
  if (!owned || !owned.length) throw new Error('from address not owned by account');

  const trimmedSubject = String(subject || '').trim() || '(no subject)';
  const finalSubject = /^re:/i.test(trimmedSubject) ? trimmedSubject : `Re: ${trimmedSubject}`;

  const result = await sendPlatformEmail(
    { from: fromAddr, to: [to], subject: finalSubject, html: bodyHtml, replyTo: fromAddr },
    accountId,
  );
  const providerId: string | null = result?.id ?? null;

  const nowIso = new Date().toISOString();
  const { error: insertError } = await supabase.from('inbox_messages').insert([
    {
      account_id: accountId,
      contact_id: row.contact_id ?? null,
      thread_id: row.thread_id,
      direction: 'outbound',
      from_addr: fromAddr,
      to_addr: to,
      subject: finalSubject,
      body: bodyHtml,
      is_read: true,
      received_at: nowIso,
    },
  ]);
  if (insertError) throw insertError;

  // Best-effort mirror into the unified conversations model — never let a
  // mirror failure fail the send, the inbox_messages row above already is
  // the source of truth.
  try {
    await recordConversationMessage({
      accountId,
      contactId: row.contact_id ?? null,
      channel: 'email',
      direction: 'outbound',
      threadKey: row.thread_id,
      fromAddr,
      toAddr: to,
      subject: finalSubject,
      body: bodyHtml,
    });
  } catch {
    // swallow — best-effort mirror only
  }

  return { sent: true, providerId, from: fromAddr, to };
}
