import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { linkedinConfigured, buildLinkedinAuthorizeUrl, signState } from '@/lib/social/linkedin-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!linkedinConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=linkedin_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildLinkedinAuthorizeUrl(state));
}

export const GET = withApi(GET__impl as any, { route: '/api/social/linkedin/connect', method: 'GET' });
