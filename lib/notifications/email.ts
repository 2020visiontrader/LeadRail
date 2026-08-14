// Best-effort email fan-out for in-app notifications. Sends from LeadRail's own
// leadrail.xyz Resend account (never FilmOps). This NEVER throws and NEVER
// blocks notification creation — an email failure must not break the app.
//
// Sender identity (overridable via env):
//   From:     LeadRail <francksayshello@leadrail.xyz>
//   Reply-To: hello@leadrail.xyz
// SMS/push are intentionally not wired; Telegram/WhatsApp are a future
// user-connectable channel. For now, email only.

import { supabase } from '@/lib/db';
import { sendPlatformEmail } from '@/lib/integrations/resend';
import type { NotificationRow } from '@/lib/notifications/store';

const NOTIFY_FROM = process.env.LEADRAIL_NOTIFY_FROM || 'LeadRail <francksayshello@leadrail.xyz>';
const NOTIFY_REPLY_TO = process.env.LEADRAIL_NOTIFY_REPLY_TO || 'hello@leadrail.xyz';
const APP_BASE_URL = process.env.LEADRAIL_APP_URL || 'https://app.leadrail.xyz';

/** Resolve who should receive a platform email for this account: owners/admins
 *  first, falling back to any member. Returns de-duped, lowercased addresses. */
async function recipientEmails(accountId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('account_members')
    .select('email, role')
    .eq('account_id', accountId);
  if (error || !data?.length) return [];
  const owners = data.filter((m) => m.role === 'owner' || m.role === 'admin');
  const chosen = (owners.length ? owners : data).map((m) => String(m.email || '').trim().toLowerCase());
  return [...new Set(chosen.filter(Boolean))];
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHtml(n: NotificationRow): string {
  const title = escapeHtml(n.title);
  const body = n.body ? `<p style="margin:0 0 16px;color:#334155;font-size:14px;line-height:1.6">${escapeHtml(n.body)}</p>` : '';
  const href = n.link ? (n.link.startsWith('http') ? n.link : `${APP_BASE_URL}${n.link.startsWith('/') ? '' : '/'}${n.link}`) : APP_BASE_URL;
  const cta = n.link
    ? `<a href="${escapeHtml(href)}" style="display:inline-block;background:#0A0F1F;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600">Open in LeadRail</a>`
    : '';
  return `<div style="font-family:Inter,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:24px">
  <div style="font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:#64748b;margin-bottom:12px">LeadRail</div>
  <h1 style="margin:0 0 12px;font-size:18px;color:#0A0F1F">${title}</h1>
  ${body}${cta}
  <p style="margin:24px 0 0;color:#94a3b8;font-size:12px">You're receiving this because you own or manage this LeadRail account.</p>
</div>`;
}

/** Fire-and-forget email for a notification. Swallows all errors. */
export async function emailNotification(accountId: string, n: NotificationRow): Promise<void> {
  try {
    if (!process.env.LEADRAIL_RESEND_API_KEY) return; // backward-compat: off when no key
    const to = await recipientEmails(accountId);
    if (!to.length) return;
    await sendPlatformEmail(
      {
        from: NOTIFY_FROM,
        to,
        subject: n.title,
        html: renderHtml(n),
        replyTo: NOTIFY_REPLY_TO,
        tags: [{ name: 'kind', value: 'notification' }],
      },
      accountId,
    );
  } catch {
    // never surface — notification email is best-effort
  }
}
