import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { publicBase } from '@/lib/social/meta-oauth';
import { verifyState, exchangeGmailCode, getGmailUserEmail } from '@/lib/email/gmail';
import { connectGmailAccount, GmailAlreadyConnectedError } from '@/lib/email/gmail-account';

export const dynamic = 'force-dynamic';

// Google OAuth redirect target for Gmail. Verifies state, exchanges the code
// for tokens, fetches the address from userinfo, and stores the refresh
// token per-account (see lib/email/gmail-account.ts). Refuses cleanly, with
// the existing address named in the redirect, if this account already has a
// connected Gmail row — this endpoint intentionally never overwrites one.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const url = new URL(req.url);
  const error = url.searchParams.get('error');
  if (error) return NextResponse.redirect(`${origin}/settings?error=gmail_denied&detail=${encodeURIComponent(error)}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return NextResponse.redirect(`${origin}/settings?error=gmail_bad_state`);

  const st = await verifyState(state).catch(() => null);
  const accountId = st?.accountId;
  if (!accountId) return NextResponse.redirect(`${origin}/settings?error=gmail_bad_state`);

  try {
    const tokens = await exchangeGmailCode(code);
    if (!tokens.refreshToken) {
      // Google only omits this when access_type/prompt were wrong for a
      // fresh grant, or (rarely) an existing grant already has one Google
      // won't reissue without prompt=consent forcing it — either way,
      // storing nothing here would silently create an unrefreshable
      // connection, so this is refused instead.
      return NextResponse.redirect(`${origin}/settings?error=gmail_no_refresh_token`);
    }
    const email = await getGmailUserEmail(tokens.accessToken);
    if (!email) return NextResponse.redirect(`${origin}/settings?error=gmail_no_email`);

    const scopes = tokens.scope ? tokens.scope.split(' ').filter(Boolean) : [];
    await connectGmailAccount({
      accountId,
      address: email,
      refreshToken: tokens.refreshToken,
      scopes,
      expiresInSec: tokens.expiresIn,
    });
    return NextResponse.redirect(`${origin}/settings?connected=gmail&email=${encodeURIComponent(email.toLowerCase())}`);
  } catch (e: any) {
    if (e instanceof GmailAlreadyConnectedError) {
      return NextResponse.redirect(
        `${origin}/settings?error=gmail_already_connected&existing=${encodeURIComponent(e.existingAddress)}`,
      );
    }
    return NextResponse.redirect(`${origin}/settings?error=gmail_exchange&detail=${encodeURIComponent(e?.message || 'exchange failed')}`);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/email/gmail/callback', method: 'GET' });
