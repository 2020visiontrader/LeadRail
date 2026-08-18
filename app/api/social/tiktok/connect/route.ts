import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import {
  tiktokConfigured,
  buildTiktokAuthorizeUrl,
  signState,
  generateCodeVerifier,
  codeChallengeFor,
  PKCE_COOKIE,
} from '@/lib/social/tiktok-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!tiktokConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=tiktok_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFor(verifier);
  const res = NextResponse.redirect(buildTiktokAuthorizeUrl(state, challenge));
  // httpOnly, short-lived — only carries the PKCE verifier across the redirect;
  // accountId/CSRF still come from the signed `state`, not this cookie.
  res.cookies.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/social/tiktok',
  });
  return res;
}

export const GET = withApi(GET__impl as any, { route: '/api/social/tiktok/connect', method: 'GET' });
