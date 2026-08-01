import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { handleResendWebhook } from '@/lib/integrations/resend';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Resend signs webhooks with Svix. Configure the endpoint in the Resend
// dashboard at .../api/webhooks/resend and store the signing secret
// (whsec_...) as RESEND_WEBHOOK_SECRET. Falls back to a ?token= shared secret
// for local/manual testing. Fails closed in production when neither is set.
function verifySvix(secret: string, id: string, ts: string, body: string, sigHeader: string): boolean {
  const key = secret.startsWith('whsec_') ? Buffer.from(secret.slice(6), 'base64') : Buffer.from(secret);
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  // svix-signature is space-separated "v1,<sig>" pairs — match any.
  for (const part of sigHeader.split(' ')) {
    const sig = part.includes(',') ? part.split(',')[1] : part;
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch { /* keep checking */ }
  }
  return false;
}

async function POST__impl(request: NextRequest) {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const urlToken = request.nextUrl.searchParams.get('token');
  const body = await request.text();

  if (secret && secret.startsWith('whsec_')) {
    const id = request.headers.get('svix-id') || '';
    const ts = request.headers.get('svix-timestamp') || '';
    const sig = request.headers.get('svix-signature') || '';
    if (!id || !ts || !sig || !verifySvix(secret, id, ts, body, sig)) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  } else if (secret) {
    // Non-Svix shared secret passed as ?token=
    if (urlToken !== secret) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  } else if (process.env.NODE_ENV === 'production') {
    return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
  }

  try {
    const event = JSON.parse(body);
    await handleResendWebhook(event);
    return NextResponse.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/webhooks/resend", method: "POST" });
