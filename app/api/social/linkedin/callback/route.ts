import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { verifyState, exchangeLinkedinCode, getLinkedinProfile } from '@/lib/social/linkedin-oauth';
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
    return settings(`error=linkedin_denied&detail=${encodeURIComponent(reason)}`);
  }

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const verified = await verifyState(state);
  if (!code || !verified) return settings('error=linkedin_bad_state');

  try {
    const { token, expiresIn } = await exchangeLinkedinCode(code);
    const profile = await getLinkedinProfile(token);
    if (!profile.id) return settings('error=linkedin_no_account');

    if (dbReady()) {
      await upsertConnection({
        account_id: verified.accountId,
        provider: 'linkedin',
        external_id: profile.id,
        display_name: profile.name || 'LinkedIn',
        username: profile.name || null,
        status: 'connected',
        secret_ref: 'user-oauth:linkedin',
        secret_encrypted: encryptTokenBundle({ access_token: token }),
        meta: {
          member_id: profile.id,
          // 60-day, non-silently-refreshable — surfaced so a stale token fails
          // loudly ("reconnect LinkedIn") instead of a mysterious publish error.
          expires_at: expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
          source: 'linkedin_oauth',
          connected_at: new Date().toISOString(),
        },
      });
    }

    return settings(`connected=linkedin&linkedin=${encodeURIComponent(profile.name || 'account')}`);
  } catch (e: any) {
    return settings(`error=linkedin_exchange&detail=${encodeURIComponent(e?.message || 'unknown')}`);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/linkedin/callback', method: 'GET' });
