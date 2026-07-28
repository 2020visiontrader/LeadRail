import { getContact } from '@/lib/db';
import { sendBrevoEmail } from '@/lib/integrations/brevo';

export interface OutreachRequest {
  contactId: string;
  subject: string;
  html?: string;
  templateId?: string;
}

/**
 * Single code path for sending an outreach email to a contact.
 * Used by both POST /api/outreach/send and the Hermes engine
 * (avoids server-side self-fetch, which needs an absolute URL on serverless).
 */
export async function sendOutreachEmail(req: OutreachRequest) {
  if (!req.contactId) throw new Error('contactId is required');
  if (!req.subject) throw new Error('subject is required');

  const contact = await getContact(req.contactId);

  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'noreply@example.com';
  const senderName = process.env.BREVO_SENDER_NAME || 'Marketing Agency OS';

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
