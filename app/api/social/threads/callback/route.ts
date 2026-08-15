import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeThreadsCode, getLongLivedThreadsToken, getThreadsProfile } from '@/lib/social/threads-oauth';
import { publicBase } from '@/lib/social/meta-oauth';
import { upsertConnection, dbReady } from '@/lib/db';
export const dynamic = 'force-dynamic';

async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const settings = (q: string) => NextResponse.redirect(`${origin}/settings?${q}`);

  const err = req.nextUrl.searchParams.get('error');
  if (err) {
    const reason = req.nextUrl.searchParams.get('error_description') || err;
    return settings(`error=threads_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  if (!code || !verified) return settings('error=threads_bad_state');

  try {
    const { token: shortToken } = await exchangeThreadsCode(code);
    const longToken = await getLongLivedThreadsToken(shortToken);
    const profile = await getThreadsProfile(longToken);
    if (!profile.id) return settings('error=threads_no_account');

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'threads',
        external_id: profile.id,
        display_name: profile.username || 'Threads',
        username: profile.username || null,
        status: 'connected',
        meta: {
          access_token: longToken,
          threads_user_id: profile.id,
          threads_username: profile.username,
          source: 'threads_login',
          connected_at: new Date().toISOString(),
        },
      });
    }

    return settings(`connected=threads&threads=${encodeURIComponent(profile.username || 'account')}`);
  } catch (e: any) {
    return settings(`error=threads_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/threads/callback', method: 'GET' });
