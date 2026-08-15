import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { errorResponse } from '@/lib/http';
import { ingestInboundEmail, type InboundEmailPayload } from '@/lib/inbox/ingest';

export const dynamic = 'force-dynamic';

// Generic inbound-email webhook (Resend inbound, Postmark, Mailgun, SES, or a
// manual test caller can all POST here). Auth is a shared secret since inbound
// mail providers vary in signing scheme — compare `x-inbound-secret` (or a
// `?token=` fallback like the brevo route) against INBOUND_EMAIL_SECRET.
// Fails closed in production when the secret env is unset.
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  try {
    return timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}

function verifySecret(request: NextRequest): NextResponse | null {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
    }
    return null; // dev mode: no secret configured
  }
  const header = request.headers.get('x-inbound-secret') || '';
  const urlToken = request.nextUrl.searchParams.get('token') || '';
  if (safeEqual(header, secret) || (urlToken && safeEqual(urlToken, secret))) return null;
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

/** Be liberal in what we accept: common provider field-name aliases. */
function normalizePayload(body: any): InboundEmailPayload {
  return {
    from: body?.from ?? body?.sender ?? '',
    to: body?.to ?? body?.recipient ?? '',
    subject: body?.subject ?? null,
    text: body?.text ?? body?.text_body ?? null,
    html: body?.html ?? body?.html_body ?? null,
    messageId: body?.messageId ?? body?.message_id ?? body?.['Message-Id'] ?? null,
    inReplyTo: body?.inReplyTo ?? body?.in_reply_to ?? body?.['In-Reply-To'] ?? null,
    thread: body?.thread ?? body?.thread_id ?? null,
  };
}

async function POST__impl(request: NextRequest) {
  const authError = verifySecret(request);
  if (authError) return authError;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 });
  }

  try {
    const payload = normalizePayload(body);
    const result = await ingestInboundEmail(payload);
    return NextResponse.json({ received: true, ...result });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: '/api/webhooks/inbound-email', method: 'POST' });
