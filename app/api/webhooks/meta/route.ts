import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { handleMetaWebhook } from '@/lib/integrations/meta';
import { log } from '@/lib/logger';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// Meta subscription verification handshake.
async function GET__impl(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get('hub.mode');
  const token = request.nextUrl.searchParams.get('hub.verify_token');
  const challenge = request.nextUrl.searchParams.get('hub.challenge');
  const verifyToken = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
  if (mode === 'subscribe' && token && verifyToken && token === verifyToken) {
    return new NextResponse(challenge || '', { status: 200 });
  }
  return NextResponse.json({ error: 'Verification failed' }, { status: 403 });
}

// Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body with the app secret).
async function POST__impl(request: NextRequest) {
  const appSecret = process.env.META_APP_SECRET;
  const raw = await request.text();
  if (!appSecret) {
    // Fail closed in production rather than accepting unsigned events.
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
    }
  } else {
    const sig = request.headers.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', appSecret).update(raw).digest('hex');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      // Log WHY, without ever logging the secret or the expected digest. A
      // rejected Meta webhook means real events — comments, DMs, mentions — are
      // being dropped on the floor, and previously the only trace was a bare 401
      // in the request log with nothing to distinguish "someone probed the URL"
      // from "our META_APP_SECRET no longer matches the app that is sending".
      // sigPresent + length are enough to tell those apart: absent header =
      // stray traffic; present-but-mismatched = a real delivery we are refusing.
      log.warn('meta webhook: signature mismatch', {
        sigPresent: Boolean(sig),
        sigLength: sig.length,
        expectedLength: expected.length,
        bodyBytes: raw.length,
      });
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }
  try {
    await handleMetaWebhook(JSON.parse(raw));
    return NextResponse.json({ received: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/webhooks/meta", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/webhooks/meta", method: "POST" });
