import { supabase } from '@/lib/db';

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

  const response = await fetch(`${BREVO_API_URL}/contacts`, {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(contact),
  });

  if (!response.ok) {
    throw new Error(`Brevo error: ${response.statusText}`);
  }

  return response.json();
}

export async function sendBrevoEmail(email: BrevoEmail) {
  if (!BREVO_API_KEY) throw new Error('BREVO_API_KEY not set');

  const response = await fetch(`${BREVO_API_URL}/smtp/email`, {
    method: 'POST',
    headers: {
      'api-key': BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(email),
  });

  if (!response.ok) {
    throw new Error(`Brevo email send error: ${response.statusText}`);
  }

  const data = await response.json();
  
  // Store email tracking info
  await supabase.from('email_campaigns').insert([{
    brevo_id: data.messageId,
    status: 'sent',
    sent_at: new Date(),
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

export async function handleBrevoWebhook(event: any) {
  const { messageId, event: eventType, contact } = event;

  if (eventType === 'opened') {
    await supabase.from('email_campaigns').update({ opened_at: new Date() }).eq('brevo_id', messageId);
  }
  if (eventType === 'click') {
    await supabase.from('contact_events').insert([{
      contact_email: contact,
      event_type: 'link_clicked',
      timestamp: new Date(),
    }]);
  }
  if (eventType === 'bounce' || eventType === 'complaint') {
    await supabase.from('email_campaigns').update({ status: 'bounced' }).eq('brevo_id', messageId);
  }
}