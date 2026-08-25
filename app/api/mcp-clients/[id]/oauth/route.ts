import { withApi, requireSession, errorResponse, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getMcpClient } from '@/lib/mcp/clients';
import {
  discoverAuthServer, registerClient, createPkce, createState,
  buildAuthorizeUrl, saveAuthState, saveDiscovery, disconnectOauth, purgeExpiredAuthStates,
} from '@/lib/mcp/oauth';
import { publicBase } from '@/lib/social/meta-oauth';

export const dynamic = 'force-dynamic';

/** The single registered redirect. Fixed, not derived from the request: a
 *  redirect_uri taken from a header or a query param is how an open redirect
 *  turns into a stolen authorization code. */
function redirectUri(): string {
  return `${publicBase()}/api/mcp-clients/oauth/callback`;
}

// POST /api/mcp-clients/[id]/oauth — begin authorization.
//
// Does the whole preparation server-side (discovery, registration if needed,
// PKCE) and hands back a URL for the browser to visit. The client never sees
// the verifier, which is the point.
async function POST__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  const clientRowId = ctx?.params?.id;
  if (!clientRowId) return badRequest('missing server id');

  try {
    const row = await getMcpClient(session.accountId, clientRowId);
    if (!row) return NextResponse.json({ error: 'No such MCP server for this account.' }, { status: 404 });

    void purgeExpiredAuthStates();

    const meta = await discoverAuthServer(row.url);

    // Reuse an existing registration. Re-registering on every connect would
    // leave a trail of orphaned clients on the provider's side and lose any
    // consent already granted to the current client_id.
    let clientId = row.oauth_client_id ?? null;
    if (!clientId) {
      const reg = await registerClient(meta, redirectUri());
      clientId = reg.client_id;
      await saveDiscovery(session.accountId, clientRowId, meta, reg, meta.scopes_supported?.join(' '));
    } else {
      await saveDiscovery(session.accountId, clientRowId, meta, { client_id: clientId }, row.oauth_scope ?? meta.scopes_supported?.join(' '));
    }

    const { verifier, challenge } = createPkce();
    const state = createState();
    await saveAuthState({
      state,
      accountId: session.accountId,
      clientId: clientRowId,
      verifier,
      redirectUri: redirectUri(),
    });

    const url = buildAuthorizeUrl({
      meta,
      clientId,
      redirectUri: redirectUri(),
      state,
      challenge,
      scope: row.oauth_scope ?? meta.scopes_supported?.join(' '),
      // Binds the token to this MCP endpoint on servers implementing RFC 8707.
      resource: row.url,
    });

    return NextResponse.json({ authorizeUrl: url, issuer: meta.issuer });
  } catch (e: any) {
    // Discovery and registration failures are the common case and each has a
    // different fix, so the message is relayed rather than flattened to 500.
    return NextResponse.json({ error: String(e?.message || e).slice(0, 400) }, { status: 400 });
  }
}

// DELETE /api/mcp-clients/[id]/oauth — revoke locally, keep the registration.
async function DELETE__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const clientRowId = ctx?.params?.id;
  if (!clientRowId) return badRequest('missing server id');
  try {
    await disconnectOauth(session.accountId, clientRowId);
    return NextResponse.json({ disconnected: true });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: '/api/mcp-clients/[id]/oauth', method: 'POST' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/mcp-clients/[id]/oauth', method: 'DELETE' });
