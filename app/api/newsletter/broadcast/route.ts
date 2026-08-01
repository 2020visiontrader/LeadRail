import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase, dbReady, assertBrandOwned } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { sendResendEmail, getResendApiKey } from '@/lib/integrations/resend';
import { filterSuppressed } from '@/lib/suppressions';

export const dynamic = 'force-dynamic';

const MAX_RECIPIENTS = 500;

interface Recipient { id: string; name: string | null; email: string; }

function personalize(text: string, r: Recipient): string {
  const first = (r.name || '').trim().split(/\s+/)[0] || 'there';
  return text
    .replace(/\{\{name\}\}/g, r.name || 'there')
    .replace(/\{\{first_name\}\}/g, first)
    .replace(/\{\{email\}\}/g, r.email);
}

// Recipients are always constrained to the caller's account_id.
async function resolveRecipients(body: any, accountId: string): Promise<Recipient[]> {
  const contactIds: string[] = Array.isArray(body?.contactIds) ? body.contactIds : [];
  const brandId = String(body?.brandId || '');
  const segment = String(body?.segment || '');

  let q = supabase.from('contacts').select('id, name, email, status, segment').eq('account_id', accountId);

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

  const eligible = (data || [])
    .filter((c: any) => c.email && String(c.status || '').toLowerCase() !== 'unsubscribed')
    .map((c: any) => ({ id: c.id, name: c.name, email: c.email }));

  // Drop anyone on the account suppression/blocklist (hard bounces, complaints,
  // unsubscribes, manual). Compliance-critical: never send to a suppressed address.
  return filterSuppressed(accountId, eligible);
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  try {
    if (!dbReady()) return NextResponse.json({ error: 'Database not configured' }, { status: 503 });

    const body = await request.json();
    const accountId = session.accountId;
    const subject = String(body?.subject || '').trim();
    const html = String(body?.html || '').trim();

    if (!subject) return badRequest('subject is required');
    if (!html) return badRequest('html is required');
    if (body?.brandId && !(await assertBrandOwned(String(body.brandId), accountId))) return badRequest('unknown brandId');

    try {
      await getResendApiKey(accountId);
    } catch {
      return NextResponse.json({ error: 'No Resend key — connect Resend in Settings → Integrations' }, { status: 409 });
    }

    const senderEmail =
      String(body?.from || '') ||
      process.env.RESEND_SENDER_EMAIL ||
      process.env.BREVO_SENDER_EMAIL ||
      'onboarding@resend.dev';
    const senderName = process.env.RESEND_SENDER_NAME || process.env.BREVO_SENDER_NAME || 'LeadRail';
    const from = senderEmail.includes('<') ? senderEmail : `${senderName} <${senderEmail}>`;

    let recipients = await resolveRecipients(body, accountId);

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

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/newsletter/broadcast", method: "POST" });
