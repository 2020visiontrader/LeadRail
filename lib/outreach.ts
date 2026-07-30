import { getContact, getContactUnscoped } from '@/lib/db';
import { sendResendEmail } from '@/lib/integrations/resend';
import { sendBrevoEmail } from '@/lib/integrations/brevo';
import { isSuppressed } from '@/lib/suppressions';
import { injectTracking } from '@/lib/tracking';

/** Thrown when a send is blocked by the account's suppression list. Callers
 *  should treat this as "skip", not "error" (the enrollment is not retried). */
export class SuppressedError extends Error {
  constructor(email: string) {
    super(`suppressed: ${email}`);
    this.name = 'SuppressedError';
  }
}

export interface OutreachRequest {
  contactId: string;
  subject: string;
  html?: string;
  templateId?: string;
  /**
   * When set (user-facing calls), the contact fetch is scoped to this account so
   * a caller cannot email another tenant's contact. Omit only for trusted
   * background runners (sequences/hermes) whose contactId comes from own-account rows.
   */
  accountId?: string;
  /** Enrollment + step ids: enable open/click attribution when present. */
  enrollmentId?: string;
  stepId?: string;
  /** Pitch decks / images to ride along. Small files attach to the email; all
   *  are also surfaced as links in the body so decks stay accessible. */
  attachments?: Array<{ url: string; filename: string; mime?: string }>;
}

function attachmentsBlock(atts: NonNullable<OutreachRequest['attachments']>): string {
  if (!atts.length) return '';
  const items = atts
    .map((a) => `<li><a href="${a.url}" style="color:#2563eb">${a.filename}</a></li>`)
    .join('');
  return `<div style="margin-top:16px;padding-top:12px;border-top:1px solid #e5e7eb"><p style="margin:0 0 6px;font-size:13px;color:#6b7280">Attachments</p><ul style="margin:0;padding-left:18px;font-size:14px">${items}</ul></div>`;
}

export async function sendOutreachEmail(req: OutreachRequest) {
  if (!req.contactId) throw new Error('contactId is required');
  if (!req.subject) throw new Error('subject is required');

  const contact = req.accountId
    ? await getContact(req.contactId, req.accountId)
    : await getContactUnscoped(req.contactId);

  // Suppression is enforced here so EVERY caller (sequences, hermes, direct) is
  // covered, using the contact's own account_id as the scope of truth.
  const scopeAccountId = req.accountId || contact.account_id;
  if (scopeAccountId && (await isSuppressed(scopeAccountId, contact.email))) {
    throw new SuppressedError(contact.email);
  }

  const atts = req.attachments || [];
  const bodyWithAtts = atts.length ? `${req.html || ''}${attachmentsBlock(atts)}` : req.html;

  const trackedHtml = bodyWithAtts
    ? await injectTracking(bodyWithAtts, {
        a: scopeAccountId,
        c: contact.id,
        e: req.enrollmentId,
        s: req.stepId,
      })
    : bodyWithAtts;

  // Attach smaller files (e.g. hero images) to the email; big decks stay as the
  // in-body link only, to protect deliverability.
  const resendAttachments = atts
    .filter((a) => a.url)
    .map((a) => ({ filename: a.filename, path: a.url }));

  const senderEmail = process.env.RESEND_SENDER_EMAIL
    || process.env.BREVO_SENDER_EMAIL
    || 'onboarding@resend.dev';
  const senderName = process.env.RESEND_SENDER_NAME
    || process.env.BREVO_SENDER_NAME
    || 'LeadRail CRM';
  const from = `${senderName} <${senderEmail}>`;

  // Resend primary, Brevo fallback
  const result = process.env.RESEND_API_KEY
    ? await sendResendEmail(
        {
          from,
          to: [contact.email],
          subject: req.subject,
          html: trackedHtml || `<p>Hi ${contact.name},</p>`,
          replyTo: process.env.REPLY_TO_EMAIL || undefined,
          attachments: resendAttachments.length ? resendAttachments : undefined,
        },
        contact.id,
        req.templateId,
      )
    : await sendBrevoEmail(
        {
          to: [{ email: contact.email, name: contact.name }],
          subject: req.subject,
          htmlContent: trackedHtml || `<p>Hi ${contact.name},</p>`,
          sender: { name: senderName, email: senderEmail },
        },
        contact.id,
        req.templateId,
      );

  // Phase D #14: mirror the outbound message into the unified conversation
  // thread so a contact's two-sided history lives in one place. Best-effort.
  if (scopeAccountId) {
    import('@/lib/conversations').then(({ recordConversationMessage }) =>
      recordConversationMessage({
        accountId: scopeAccountId,
        contactId: contact.id,
        channel: 'email',
        direction: 'outbound',
        toAddr: contact.email,
        fromAddr: senderEmail,
        subject: req.subject,
        body: trackedHtml || null,
      }),
    ).catch(() => {});
  }

  return result;
}
