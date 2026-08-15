import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { googleConfigured, buildGoogleAuthorizeUrl, signState } from '@/lib/social/google-oauth';
import { publicBase } from '@/lib/social/meta-oauth';

export const dynamic = 'force-dynamic';

// Starts the Google Drive OAuth flow. Session-gated; the account id is read from
// the verified session and carried (signed) in state so the callback can bind
// the connection to the right LeadRail account.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!googleConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=gdrive_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.redirect(`${origin}/login?next=/settings`);
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildGoogleAuthorizeUrl(state));
}

export const GET = withApi(GET__impl as any, { route: '/api/social/google-drive/connect', method: 'GET' });
