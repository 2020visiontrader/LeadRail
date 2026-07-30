import { supabase, getConnections, findContactByEmailUnscoped } from '@/lib/db';
import { withRetry } from '@/lib/integrations/retry';
import { addSuppression } from '@/lib/suppressions';

const RESEND_API_URL = 'https://api.resend.com';
const ENV_RESEND_API_KEY = process.env.RESEND_API_KEY;

export interface ResendEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
}

/**
 * Resolve the Resend key for an account: prefer the account-scoped key stored
 * in integration_connections (meta.access_token), fall back to the env key.
 */
export async function getResendApiKey(accountId?: string): Promise<string> {
  if (accountId) {
    try {
      const conns = await getConnections(accountId);
      const resendConn = conns.find((c) => c.provider === 'resend' && c.status === 'connected');
      if (resendConn?.meta?.access_token) return String(resendConn.meta.access_token);
    } catch {
      // fall through to env
    }
  }
  if (!ENV_RESEND_API_KEY) throw new Error('RESEND_API_KEY not set — connect Resend in Settings → Integrations');
  return ENV_RESEND_API_KEY;
}

export async function sendResendEmail(
  email: ResendEmail,
  contactId: string,
  templateId?: string,
  accountId?: string
) {
  const apiKey = await getResendApiKey(accountId);
  if (!contactId) throw new Error('contactId is required to record an email campaign');

  const data = await withRetry(() =>
    fetch(`${RESEND_API_URL}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(email),
    }).then(async (r) => {
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Resend email send error: ${r.status} ${r.statusText} — ${body}`);
      }
      return r.json();
    })
  );

  await supabase.from('email_campaigns').insert([
    {
      contact_id: contactId,
      template_id: templateId ?? null,
      subject: email.subject,
      body: email.html,
      status: 'sent',
      brevo_id: data.id,
      sent_at: new Date().toISOString(),
    },
  ]);

  return data;
}

/**
 * Handle a verified Resend webhook event. Resend is the primary sender, so
 * without this bounces/complaints never suppress — the platform keeps hitting
 * dead/complaining addresses and burns domain reputation. Events we act on:
 *   email.bounced / email.complained → suppress + mark contact dead + flip campaign
 *   email.opened / email.clicked      → reflect engagement on the campaign row
 * The Resend message id is stored in email_campaigns.brevo_id at send time.
 */
export async function handleResendWebhook(event: any) {
  const type: string = event?.type || '';
  const data = event?.data || {};
  const emailId: string | undefined = data.email_id || data.id;
  const recipients: string[] = Array.isArray(data.to) ? data.to : data.to ? [String(data.to)] : [];

  if (type === 'email.opened' && emailId) {
    await supabase.from('email_campaigns').update({ opened_at: new Date().toISOString(), status: 'opened' }).eq('brevo_id', emailId);
    return;
  }
  if (type === 'email.clicked' && emailId) {
    await supabase.from('email_campaigns').update({ status: 'opened' }).eq('brevo_id', emailId).is('opened_at', null);
    return;
  }
  if (type === 'email.bounced' || type === 'email.complained') {
    if (emailId) await supabase.from('email_campaigns').update({ status: 'bounced' }).eq('brevo_id', emailId);
    for (const email of recipients) {
      if (!email) continue;
      const contact = await findContactByEmailUnscoped(email);
      if (contact?.account_id) {
        await addSuppression({
          accountId: contact.account_id,
          email,
          reason: type === 'email.bounced' ? 'hard_bounce' : 'complaint',
          source: 'resend_webhook',
        });
        await supabase.from('contacts').update({ status: 'dead' }).eq('id', contact.id).eq('account_id', contact.account_id);
      }
    }
  }
}
