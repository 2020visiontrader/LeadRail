import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { upsertConnection } from '@/lib/db';
import { publicBase } from '@/lib/social/meta-oauth';
import { verifyState, exchangeGoogleCode, getGoogleEmail } from '@/lib/social/google-oauth';
import { encryptTokenBundle } from '@/lib/social/connection-token';

export const dynamic = 'force-dynamic';

// Google OAuth redirect target. Verifies state, exchanges the code for the
// user's tokens, and stores them per-account (provider 'google_drive'). The
// refresh token makes the connection long-lived; gdrive.ts refreshes as needed.
async function GET__impl(req: NextRequest) {
  const origin = publicBase();
  const url = new URL(req.url);
  const error = url.searchParams.get('error');
  if (error) return NextResponse.redirect(`${origin}/settings?error=gdrive_denied&detail=${encodeURIComponent(error)}`);

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return NextResponse.redirect(`${origin}/settings?error=gdrive_bad_state`);

  const st = await verifyState(state).catch(() => null);
  const accountId = st?.accountId;
  if (!accountId) return NextResponse.redirect(`${origin}/settings?error=gdrive_bad_state`);

  try {
    const tokens = await exchangeGoogleCode(code);
    const email = await getGoogleEmail(tokens.accessToken);
    await upsertConnection({
      account_id: accountId,
      provider: 'google_drive',
      external_id: email,
      display_name: email,
      username: email,
      status: 'connected',
      secret_ref: 'user-oauth:google_drive',
      secret_encrypted: encryptTokenBundle({ access_token: tokens.accessToken, refresh_token: tokens.refreshToken }),
      meta: {
        expiry_ms: Date.now() + tokens.expiresIn * 1000,
        email,
        // Recorded so lib/integrations/gdrive.ts's requireDriveWriteToken can
        // tell a write-capable connection from a read-only one WITHOUT ever
        // trusting DRIVE_SCOPE (what we asked for) over what Google actually
        // granted — see the GoogleTokens.scope comment in google-oauth.ts.
        scope: tokens.scope,
      },
    });
    return NextResponse.redirect(`${origin}/settings?connected=google_drive&email=${encodeURIComponent(email)}`);
  } catch (e: any) {
    return NextResponse.redirect(`${origin}/settings?error=gdrive_exchange&detail=${encodeURIComponent(e?.message || 'exchange failed')}`);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/social/google-drive/callback', method: 'GET' });
