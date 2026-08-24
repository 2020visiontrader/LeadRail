import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { handleMetaWebhook } from '@/lib/integrations/meta';
import { log } from '@/lib/logger';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';
// Explicit: this route MUST run on Node. It reads the raw body and HMACs it with
// node:crypto; on the edge runtime createHmac does not exist. The node:crypto
// import already forces this in practice — pinning it stops a future default
// change from silently breaking signature verification.
export const runtime = 'nodejs';

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

// Every Meta-family app secret this deployment might receive webhooks from.
//
// The route used to verify against META_APP_SECRET alone. That is only correct
// when one app sends everything — and this deployment connects Instagram and
// Threads through their OWN apps (INSTAGRAM_APP_SECRET / THREADS_APP_SECRET,
// see lib/social/instagram-oauth.ts and threads-oauth.ts), each signing with
// its own secret. Every delivery from those apps therefore failed the check and
// was answered 401: 9,090 rejected deliveries in six days, every one of them a
// real comment, mention or DM dropped on the floor while the inbox looked
// quiet. A signature is valid if it verifies against ANY configured secret;
// that is not a weaker check — each candidate is still a full HMAC over the raw
// body, and an attacker without one of these secrets can forge none of them.
function appSecrets(): { name: string; secret: string }[] {
  return [
    { name: 'META_APP_SECRET', secret: process.env.META_APP_SECRET },
    { name: 'INSTAGRAM_APP_SECRET', secret: process.env.INSTAGRAM_APP_SECRET },
    { name: 'THREADS_APP_SECRET', secret: process.env.THREADS_APP_SECRET },
  ].filter((c): c is { name: string; secret: string } => Boolean(c.secret));
}

function fingerprint(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 8);
}

/** Constant-time compare of the delivered signature against one secret. */
function signatureMatches(sig: string, raw: string, secret: string): boolean {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Verify X-Hub-Signature-256 (HMAC-SHA256 of raw body with an app secret).
async function POST__impl(request: NextRequest) {
  const candidates = appSecrets();
  const raw = await request.text();
  if (!candidates.length) {
    // Fail closed in production rather than accepting unsigned events.
    if (process.env.NODE_ENV === 'production') {
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 503 });
    }
  } else {
    const sig = request.headers.get('x-hub-signature-256') || '';
    const matched = sig ? candidates.find((c) => signatureMatches(sig, raw, c.secret)) : undefined;
    if (!matched) {
      // Log WHY, without ever logging a secret or an expected digest. A
      // rejected Meta webhook means real events — comments, DMs, mentions — are
      // being dropped on the floor, and previously the only trace was a bare 401
      // in the request log with nothing to distinguish "someone probed the URL"
      // from "none of our app secrets match the app that is sending".
      // sigPresent + length are enough to tell those apart: absent header =
      // stray traffic; present-but-mismatched = a real delivery we are refusing.
      //
      // The fingerprints are ONE-WAY sha256 prefixes of each configured secret —
      // never a secret, not reversible. They exist so a mismatch can be proved
      // rather than guessed: for the app that is actually sending, run
      //   printf %s "<App Secret from Meta > App > Settings > Basic>" | shasum -a 256
      // and compare the first 8 characters against the list below. A missing
      // fingerprint means that app's secret is not configured here at all, which
      // is the usual cause and the actual fix.
      log.warn('meta webhook: signature mismatch', {
        sigPresent: Boolean(sig),
        sigLength: sig.length,
        bodyBytes: raw.length,
        rawBodyHashed: true,
        secretsTried: candidates.length,
        secretFingerprints: candidates.map((c) => `${c.name}:${fingerprint(c.secret)}`),
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
