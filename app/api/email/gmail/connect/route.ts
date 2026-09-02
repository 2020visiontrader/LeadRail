import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { gmailConfigured, buildGmailAuthorizeUrl, signState } from '@/lib/email/gmail';
import { publicBase } from '@/lib/social/meta-oauth';

export const dynamic = 'force-dynamic';

// Starts the Gmail OAuth flow. Session-gated; the account id is read from the
// verified session and carried (HMAC-signed, lib/social/meta-oauth.ts) in
// state so the callback can bind the connection to the right LeadRail
// account and the state can't be forged or replayed past its 10-minute TTL.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!gmailConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=gmail_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.redirect(`${origin}/login?next=/settings`);
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildGmailAuthorizeUrl(state));
}

export const GET = withApi(GET__impl as any, { route: '/api/email/gmail/connect', method: 'GET' });
