import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { instagramConfigured, buildInstagramAuthorizeUrl, signState } from '@/lib/social/instagram-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
export const dynamic = 'force-dynamic';

// Starts the Instagram Login OAuth flow (standalone IG accounts). Session-gated;
// account id is read from the verified session and carried in the signed state.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!instagramConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=ig_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildInstagramAuthorizeUrl(state));
}

export const GET = withApi(GET__impl as any, { route: '/api/social/instagram/connect', method: 'GET' });
