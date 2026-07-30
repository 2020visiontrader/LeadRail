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

  const trackedHtml = req.html
    ? await injectTracking(req.html, {
        a: scopeAccountId,
        c: contact.id,
        e: req.enrollmentId,
        s: req.stepId,
      })
    : req.html;

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
