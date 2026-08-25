import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getMcpClientRaw } from '@/lib/mcp/clients';
import { consumeAuthState, exchangeCode, saveTokens } from '@/lib/mcp/oauth';
import { decryptSecret } from '@/lib/ai/crypto';
import { publicBase } from '@/lib/social/meta-oauth';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// The authorization server redirects the user's browser here.
//
// NO SESSION COOKIE IS REQUIRED, and none is trusted. Identity comes from the
// `state` value, which was minted server-side, stored with the account it
// belongs to, and is single-use — consumeAuthState deletes it on read. That is
// the same pattern the Meta OAuth callback uses, and it is why this route is
// listed in PUBLIC_API: a third-party redirect cannot be relied upon to carry
// our cookies (SameSite), so the state IS the credential.
//
// Every failure path lands the user back on Admin with a readable reason
// rather than a bare error page — they are mid-task, in a browser, and a JSON
// 400 here is a dead end.
async function GET__impl(req: NextRequest) {
  const back = (q: string) => NextResponse.redirect(`${publicBase()}/admin?${q}`);

  const params = req.nextUrl.searchParams;
  const err = params.get('error');
  if (err) {
    const detail = params.get('error_description') || err;
    return back(`mcp_oauth=denied&detail=${encodeURIComponent(detail.slice(0, 200))}`);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) return back('mcp_oauth=bad_request');

  // Single-use: a replayed callback finds nothing here.
  const pending = await consumeAuthState(state);
  if (!pending) return back('mcp_oauth=expired');

  try {
    const row = await getMcpClientRaw(pending.accountId, pending.clientId);
    if (!row?.oauth_token_url || !row?.oauth_client_id) {
      return back('mcp_oauth=not_registered');
    }

    const tokens = await exchangeCode({
      meta: {
        issuer: row.oauth_issuer || '',
        authorization_endpoint: row.oauth_authorize_url || '',
        token_endpoint: row.oauth_token_url,
      },
      clientId: row.oauth_client_id,
      clientSecret: row.oauth_client_secret_encrypted ? decryptSecret(row.oauth_client_secret_encrypted) : undefined,
      code,
      redirectUri: pending.redirectUri,
      verifier: pending.verifier,
      resource: row.url,
    });

    await saveTokens(pending.accountId, pending.clientId, tokens);
    return back(`mcp_oauth=connected&server=${encodeURIComponent(row.name)}`);
  } catch (e: any) {
    // The token exchange is where a misconfigured redirect URI or a rejected
    // PKCE challenge surfaces, and both are silent from the user's side, so the
    // reason is logged in full and summarised on the redirect.
    log.error('mcp oauth: token exchange failed', e, {
      accountId: pending.accountId, clientId: pending.clientId,
    });
    return back(`mcp_oauth=exchange_failed&detail=${encodeURIComponent(String(e?.message || e).slice(0, 200))}`);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/mcp-clients/oauth/callback', method: 'GET' });
