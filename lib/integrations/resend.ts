import { supabase, getConnections, findContactByEmailUnscoped } from '@/lib/db';
import { withRetry } from '@/lib/integrations/retry';
import { addSuppression } from '@/lib/suppressions';

const RESEND_API_URL = 'https://api.resend.com';
// LeadRail's OWN Resend account (domain leadrail.xyz). Deliberately NOT the
// FilmOps RESEND_API_KEY — LeadRail and FilmOps must never share a sending
// account/domain. If this is unset, we error rather than borrow another
// product's account.
const ENV_RESEND_API_KEY = process.env.LEADRAIL_RESEND_API_KEY;

// Per-brand Resend accounts. Each brand can have its own verified sending
// domain/account; unlisted or unknown brands fall back to LeadRail's own
// leadrail.xyz key (today's behavior, unchanged). NEVER map a brand to
// RESEND_API_KEY — that's the separate FilmOps account and must stay out of
// LeadRail's send path entirely.
// To onboard a new brand's own Resend account, add one line here.
const BRAND_RESEND_ENV_KEYS: Record<string, string | undefined> = {
  rentahub: process.env.RENTAHUB_RESEND_API_KEY,
  filmops: process.env.FILMOPS_RESEND_API_KEY,
};

/**
 * Resolve the Resend API key to use for a given brand. Known brands with
 * their own verified Resend account use that account's key; every other
 * brand (including unknown or missing brand ids) uses LeadRail's own
 * leadrail.xyz key — i.e. today's behavior, unchanged.
 */
export function resendApiKeyForBrand(brandId?: string | null): string | undefined {
  if (brandId && BRAND_RESEND_ENV_KEYS[brandId]) return BRAND_RESEND_ENV_KEYS[brandId];
  return ENV_RESEND_API_KEY;
}

export interface ResendEmail {
  from: string;
  to: string[];
  subject: string;
  html: string;
  replyTo?: string;
  tags?: Array<{ name: string; value: string }>;
  // Resend accepts hosted files via `path` (a URL) or inline base64 via `content`.
  attachments?: Array<{ filename: string; path?: string; content?: string }>;
}

/**
 * Resolve the Resend key for an account: prefer the account-scoped key stored
 * in integration_connections (meta.access_token), then the brand's own
 * account (e.g. rentahub), then LeadRail's own env key.
 */
export async function getResendApiKey(accountId?: string, brandId?: string | null): Promise<string> {
  if (accountId) {
    try {
      const conns = await getConnections(accountId);
      const resendConn = conns.find((c) => c.provider === 'resend' && c.status === 'connected');
      if (resendConn?.meta?.access_token) return String(resendConn.meta.access_token);
    } catch {
      // fall through to brand/env
    }
  }
  const key = resendApiKeyForBrand(brandId);
  if (!key) throw new Error('LEADRAIL_RESEND_API_KEY not set — connect LeadRail\'s Resend (leadrail.xyz) in Settings → Integrations');
  return key;
}

/**
 * Lightweight transactional send for PLATFORM email (notifications, system
 * alerts) — NOT lead outreach. Unlike sendResendEmail it takes no contactId and
 * does NOT write an email_campaigns row (these aren't campaign sends). Uses
 * LeadRail's own leadrail.xyz Resend account. Throws on failure so callers can
 * decide whether to swallow (notifications fan-out swallows).
 */
export async function sendPlatformEmail(email: ResendEmail, accountId?: string, brandId?: string | null) {
  const apiKey = await getResendApiKey(accountId, brandId);
  const payload: Record<string, unknown> = {
    from: email.from,
    to: email.to,
    subject: email.subject,
    html: email.html,
  };
  if (email.replyTo) payload.reply_to = email.replyTo;
  if (email.tags) payload.tags = email.tags;

  return withRetry(() =>
    fetch(`${RESEND_API_URL}/emails`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (r) => {
      if (!r.ok) {
        const body = await r.text();
        throw new Error(`Resend platform email error: ${r.status} ${r.statusText} — ${body}`);
      }
      return r.json();
    })
  );
}

export async function sendResendEmail(
  email: ResendEmail,
  contactId: string,
  templateId?: string,
  accountId?: string,
  brandId?: string | null
) {
  const apiKey = await getResendApiKey(accountId, brandId);
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
