import { getContact } from '@/lib/db';
import { sendResendEmail } from '@/lib/integrations/resend';
import { sendBrevoEmail } from '@/lib/integrations/brevo';

export interface OutreachRequest {
  contactId: string;
  subject: string;
  html?: string;
  templateId?: string;
}

export async function sendOutreachEmail(req: OutreachRequest) {
  if (!req.contactId) throw new Error('contactId is required');
  if (!req.subject) throw new Error('subject is required');

  const contact = await getContact(req.contactId);

  const senderEmail = process.env.RESEND_SENDER_EMAIL
    || process.env.BREVO_SENDER_EMAIL
    || 'onboarding@resend.dev';
  const senderName = process.env.RESEND_SENDER_NAME
    || process.env.BREVO_SENDER_NAME
    || 'LeadRail CRM';
  const from = `${senderName} <${senderEmail}>`;

  // Resend primary, Brevo fallback
  if (process.env.RESEND_API_KEY) {
    return sendResendEmail(
      {
        from,
        to: [contact.email],
        subject: req.subject,
        html: req.html || `<p>Hi ${contact.name},</p>`,
        replyTo: process.env.REPLY_TO_EMAIL || undefined,
      },
      contact.id,
      req.templateId
    );
  }

  // Fallback to Brevo
  return sendBrevoEmail(
    {
      to: [{ email: contact.email, name: contact.name }],
      subject: req.subject,
      htmlContent: req.html || `<p>Hi ${contact.name},</p>`,
      sender: { name: senderName, email: senderEmail },
    },
    contact.id,
    req.templateId
  );
}
