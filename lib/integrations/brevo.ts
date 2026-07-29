import { supabase, findContactByEmailUnscoped } from '@/lib/db';
import { withRetry } from '@/lib/integrations/retry';
import { addSuppression } from '@/lib/suppressions';

const BREVO_API_URL = 'https://api.brevo.com/v3';
const BREVO_API_KEY = process.env.BREVO_API_KEY;

export interface BrevoContact {
  email: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, any>;
}

export interface BrevoEmail {
  to: Array<{ email: string; name?: string }>;
  subject: string;
  htmlContent: string;
  sender: { name: string; email: string };
  replyTo?: { email: string };
  tags?: string[];
}

export async function createBrevoContact(contact: BrevoContact) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  const response = await withRetry(() =>
    fetch(`${BREVO_API_URL}/contacts`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify(contact),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Brevo error: ${r.status} ${r.statusText}`);
      return r.json();
    })
  );
  return response;
}

/**
 * Send a transactional email and record it against a contact.
 * contactId is REQUIRED because email_campaigns.contact_id is NOT NULL.
 */
export async function sendBrevoEmail(email: BrevoEmail, contactId: string, templateId?: string) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  if (!contactId) throw new Error('contactId is required to record an email campaign');

  const data = await withRetry(() =>
    fetch(`${BREVO_API_URL}/smtp/email`, {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify(email),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`Brevo email send error: ${r.status} ${r.statusText}`);
      return r.json();
    })
  );

  await supabase.from('email_campaigns').insert([{
    contact_id: contactId,
    template_id: templateId ?? null,
    subject: email.subject,
    body: email.htmlContent,
    brevo_id: data.messageId ?? null,
    status: 'sent',
    sent_at: new Date().toISOString(),
  }]);

  return data;
}

export async function getBrevoEmailStatus(messageId: string) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');
  const response = await fetch(`${BREVO_API_URL}/smtp/statistics/events?messageId=${messageId}`, {
    headers: { 'api-key': BREVO_API_KEY },
  });
  if (!response.ok) throw new Error('Failed to fetch Brevo status');
  return response.json();
}

/** Brevo webhook. Uses real schema columns; resolves contact email -> contact_id. */
export async function handleBrevoWebhook(event: any) {
  const messageId = event['message-id'] || event.messageId;
  const eventType = event.event;
  const email = event.email;

  if (eventType === 'opened' || eventType === 'unique_opened') {
    if (messageId) await supabase.from('email_campaigns').update({ opened_at: new Date().toISOString(), status: 'opened' }).eq('brevo_id', messageId);
  }
  if (eventType === 'click') {
    const contact = email ? await findContactByEmailUnscoped(email) : null;
    if (contact) {
      await supabase.from('contact_events').insert([{
        contact_id: contact.id,
        event_type: 'link_clicked',
        event_data: { message_id: messageId, url: event.link ?? null },
      }]);
    }
  }
  if (eventType === 'hard_bounce' || eventType === 'soft_bounce' || eventType === 'spam' || eventType === 'complaint') {
    if (messageId) await supabase.from('email_campaigns').update({ status: 'bounced' }).eq('brevo_id', messageId);
    // Permanent failures / complaints must never be re-sent: add to suppression list.
    if (email && (eventType === 'hard_bounce' || eventType === 'spam' || eventType === 'complaint')) {
      const contact = await findContactByEmailUnscoped(email);
      if (contact?.account_id) {
        await addSuppression({
          accountId: contact.account_id,
          email,
          reason: eventType === 'hard_bounce' ? 'hard_bounce' : 'complaint',
          source: 'webhook',
        });
      }
    }
  }
}
