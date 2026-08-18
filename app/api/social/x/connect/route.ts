import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifySession, SESSION_COOKIE } from '@/lib/session';
import {
  xConfigured,
  buildXAuthorizeUrl,
  signState,
  generateCodeVerifier,
  codeChallengeFor,
  PKCE_COOKIE,
} from '@/lib/social/x-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  if (!xConfigured()) {
    return NextResponse.redirect(`${origin}/settings?error=x_not_configured`);
  }
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) {
    return NextResponse.redirect(`${origin}/login?next=/settings`);
  }
  const state = await signState(session.accountId);
  const verifier = generateCodeVerifier();
  const challenge = await codeChallengeFor(verifier);
  const res = NextResponse.redirect(buildXAuthorizeUrl(state, challenge));
  res.cookies.set(PKCE_COOKIE, verifier, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600,
    path: '/api/social/x',
  });
  return res;
}

export const GET = withApi(GET__impl as any, { route: '/api/social/x/connect', method: 'GET' });
