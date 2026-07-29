import { supabase, getConnections } from '@/lib/db';
import { withRetry } from '@/lib/integrations/retry';

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
