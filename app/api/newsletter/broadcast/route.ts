import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';
import { sendResendEmail, getResendApiKey } from '@/lib/integrations/resend';

export const dynamic = 'force-dynamic';

const MAX_RECIPIENTS = 500;

interface Recipient {
  id: string;
  name: string | null;
  email: string;
}

function personalize(text: string, r: Recipient): string {
  const first = (r.name || '').trim().split(/\s+/)[0] || 'there';
  return text
    .replace(/\{\{name\}\}/g, r.name || 'there')
    .replace(/\{\{first_name\}\}/g, first)
    .replace(/\{\{email\}\}/g, r.email);
}

async function resolveRecipients(body: any): Promise<Recipient[]> {
  const contactIds: string[] = Array.isArray(body?.contactIds) ? body.contactIds : [];
  const brandId = String(body?.brandId || '');
  const segment = String(body?.segment || '');

  let q = supabase.from('contacts').select('id, name, email, status, segment');

  if (contactIds.length) {
    q = q.in('id', contactIds);
  } else if (brandId) {
    q = q.eq('brand_id', brandId);
    if (segment) q = q.eq('segment', segment);
  } else {
    throw new Error('brandId or contactIds is required');
  }

  const { data, error } = await q.limit(MAX_RECIPIENTS);
  if (error) throw error;

  return (data || [])
    .filter((c: any) => c.email && String(c.status || '').toLowerCase() !== 'unsubscribed')
    .map((c: any) => ({ id: c.id, name: c.name, email: c.email }));
}

/**
 * POST /api/newsletter/broadcast
 * Body: { accountId, brandId?, contactIds?, segment?, subject, html, from?, test?, testEmail? }
 *
 * Sends a newsletter via Resend (account-scoped key preferred, env fallback).
 * Records one email_campaigns row per recipient. Supports {{name}}, {{first_name}}, {{email}}.
 */
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;

  try {
    if (!dbReady()) return NextResponse.json({ error: 'Database not configured' }, { status: 503 });

    const body = await request.json();
    const accountId = String(body?.accountId || '') || undefined;
    const subject = String(body?.subject || '').trim();
    const html = String(body?.html || '').trim();

    if (!subject) return badRequest('subject is required');
    if (!html) return badRequest('html is required');

    // Fail fast with a clear message if no Resend key is available at all.
    try {
      await getResendApiKey(accountId);
    } catch {
      return NextResponse.json(
        { error: 'No Resend key — connect Resend in Settings → Integrations' },
        { status: 409 }
      );
    }

    const senderEmail =
      String(body?.from || '') ||
      process.env.RESEND_SENDER_EMAIL ||
      process.env.BREVO_SENDER_EMAIL ||
      'onboarding@resend.dev';
    const senderName = process.env.RESEND_SENDER_NAME || process.env.BREVO_SENDER_NAME || 'LeadRail';
    const from = senderEmail.includes('<') ? senderEmail : `${senderName} <${senderEmail}>`;

    let recipients = await resolveRecipients(body);

    // Test mode: single send to a specific address (or the first recipient).
    if (body?.test) {
      const testEmail = String(body?.testEmail || '');
      recipients = testEmail
        ? [{ id: recipients[0]?.id || 'test', name: 'Test', email: testEmail }]
        : recipients.slice(0, 1);
    }

    if (!recipients.length) {
      return NextResponse.json({ error: 'No eligible recipients' }, { status: 422 });
    }

    const results = { total: recipients.length, sent: 0, failed: 0, errors: [] as Array<{ email: string; error: string }> };

    // Bounded concurrency to respect Resend rate limits.
    const CONCURRENCY = 4;
    for (let i = 0; i < recipients.length; i += CONCURRENCY) {
      const batch = recipients.slice(i, i + CONCURRENCY);
      await Promise.all(
        batch.map(async (r) => {
          try {
            await sendResendEmail(
              {
                from,
                to: [r.email],
                subject: personalize(subject, r),
                html: personalize(html, r),
                replyTo: process.env.REPLY_TO_EMAIL || undefined,
                tags: [{ name: 'type', value: 'newsletter' }],
              },
              r.id,
              undefined,
              accountId
            );
            results.sent += 1;
          } catch (e: any) {
            results.failed += 1;
            results.errors.push({ email: r.email, error: String(e?.message || e).slice(0, 200) });
          }
        })
      );
    }

    return NextResponse.json(results);
  } catch (error: any) {
    const msg = String(error?.message || '');
    if (msg.includes('required')) return badRequest(msg);
    return errorResponse(error);
  }
}
