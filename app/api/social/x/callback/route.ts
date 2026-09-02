import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeXCode, getXProfile, PKCE_COOKIE } from '@/lib/social/x-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
import { encryptTokenBundle } from '@/lib/social/connection-token';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?${q}`);

  const err = req.nextUrl.searchParams.get('error');
  if (err) {
    const reason = req.nextUrl.searchParams.get('error_description') || err;
    return settings(`error=x_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  const codeVerifier = req.cookies.get(PKCE_COOKIE)?.value;
  if (!code || !verified || !codeVerifier) return settings('error=x_bad_state');

  try {
    const { token, refreshToken, expiresIn } = await exchangeXCode(code, codeVerifier);
    const profile = await getXProfile(token);
    if (!profile.id) return settings('error=x_no_account');

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'x',
        external_id: profile.id,
        display_name: profile.username ? `@${profile.username}` : 'X',
        username: profile.username || null,
        status: 'connected',
        secret_ref: 'user-oauth:x',
        secret_encrypted: encryptTokenBundle({ access_token: token, refresh_token: refreshToken }),
        meta: {
          expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
          source: 'x_oauth',
          connected_at: new Date().toISOString(),
        },
      });
    }

    const res = settings(`connected=x&x=${encodeURIComponent(profile.username || 'account')}`);
    res.cookies.delete(PKCE_COOKIE);
    return res;
  } catch (e: any) {
    const res = settings(`error=x_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
    res.cookies.delete(PKCE_COOKIE);
    return res;
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/x/callback', method: 'GET' });
