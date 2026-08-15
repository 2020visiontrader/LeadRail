import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeIgCode, getLongLivedIgToken, getIgProfile } from '@/lib/social/instagram-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
export const dynamic = 'force-dynamic';

// Instagram Login callback. Whitelisted in middleware (identity comes from the
// signed state, not a cookie). Each authorized IG account becomes its own
// `instagram` row — a user can add many independent accounts.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?${q}`);

  const err = req.nextUrl.searchParams.get('error');
  if (err) {
    const reason = req.nextUrl.searchParams.get('error_description') || err;
    return settings(`error=ig_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  if (!code || !verified) return settings('error=ig_bad_state');

  try {
    const { token: shortToken } = await exchangeIgCode(code);
    const longToken = await getLongLivedIgToken(shortToken);
    const profile = await getIgProfile(longToken);
    if (!profile.id) return settings('error=ig_no_account');

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'instagram',
        external_id: profile.id,
        display_name: profile.username || 'Instagram',
        username: profile.username || null,
        status: 'connected',
        meta: {
          access_token: longToken,
          ig_user_id: profile.id,
          ig_username: profile.username,
          source: 'instagram_login',
          connected_at: new Date().toISOString(),
        },
      });
    }

    return settings(`connected=instagram&ig=${encodeURIComponent(profile.username || 'account')}`);
  } catch (e: any) {
    return settings(`error=ig_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/instagram/callback', method: 'GET' });
