import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeTiktokCode, getTiktokProfile, PKCE_COOKIE } from '@/lib/social/tiktok-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?${q}`);

  const err = req.nextUrl.searchParams.get('error');
  if (err) {
    const reason = req.nextUrl.searchParams.get('error_description') || err;
    return settings(`error=tiktok_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  const codeVerifier = req.cookies.get(PKCE_COOKIE)?.value;
  if (!code || !verified || !codeVerifier) return settings('error=tiktok_bad_state');

  try {
    const { token, refreshToken, openId, expiresIn } = await exchangeTiktokCode(code, codeVerifier);
    const profile = await getTiktokProfile(token);
    const externalId = profile.id || openId;
    if (!externalId) return settings('error=tiktok_no_account');

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'tiktok',
        external_id: externalId,
        display_name: profile.username || 'TikTok',
        username: profile.username || null,
        status: 'connected',
        meta: {
          access_token: token,
          refresh_token: refreshToken,
          open_id: externalId,
          expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
          // Draft-only until this app passes TikTok's Content Posting API audit
          // for DIRECT_POST — see lib/social/tiktok-oauth.ts.
          publish_mode: 'draft',
          source: 'tiktok_oauth',
          connected_at: new Date().toISOString(),
        },
      });
    }

    const res = settings(`connected=tiktok&tiktok=${encodeURIComponent(profile.username || 'account')}`);
    res.cookies.delete(PKCE_COOKIE);
    return res;
  } catch (e: any) {
    const res = settings(`error=tiktok_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
    res.cookies.delete(PKCE_COOKIE);
    return res;
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/tiktok/callback', method: 'GET' });
