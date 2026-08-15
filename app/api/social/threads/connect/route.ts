import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import { threadsConfigured, buildThreadsAuthorizeUrl, signState } from '@/lib/social/threads-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!threadsConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=threads_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  return NextResponse.redirect(buildThreadsAuthorizeUrl(state));
}

export const GET = withApi(GET__impl as any, { route: '/api/social/threads/connect', method: 'GET' });
