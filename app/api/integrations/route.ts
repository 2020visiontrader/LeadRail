import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { dbReady, getConnections, upsertConnection } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

/**
 * Project a connection row down to what a browser may see.
 *
 * `getConnections` does `select('*')`, and the Meta OAuth callback writes live
 * credentials into `meta` — the Page access token and the long-lived user
 * token. Returning rows verbatim shipped those to client JS on every /settings
 * load: never rendered, but present in the response body and readable from
 * devtools, the network tab, or any script running on the page. A leaked Page
 * token publishes to that Page and its linked Instagram account without
 * touching this app at all.
 *
 * So this is an ALLOWLIST, not a blocklist: `meta` is rebuilt from two known
 * display-only fields rather than filtered for known-bad keys, because the next
 * credential someone adds to `meta` would silently pass a blocklist.
 * `secret_ref` is dropped for the same reason.
 *
 * Server-side callers keep using `getConnections` directly — capabilities and
 * the Meta client NEED the tokens. Only this browser-facing projection is
 * narrowed.
 */
function safeConnection(c: any) {
  return {
    id: c.id,
    provider: c.provider,
    external_id: c.external_id,
    display_name: c.display_name ?? null,
    username: c.username ?? null,
    status: c.status,
    created_at: c.created_at ?? null,
    updated_at: c.updated_at ?? null,
    // Display-only. via_page_name tells a user WHICH Facebook Page an Instagram
    // account came through — the disambiguator that makes six connected
    // accounts distinguishable in the UI.
    meta: {
      via_page_name: c.meta?.via_page_name ?? null,
      platform_name: c.meta?.platform_name ?? null,
    },
  };
}

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    // Backend env status (which platform services are configured) is owner-only —
    // clients must never learn the tech stack. Per-account connections stay visible.
    const isOwner = session.role === 'owner';
    const env = isOwner ? getIntegrationStatus() : {};
    let connections: any[] = [];
    if (dbReady()) connections = (await getConnections(session.accountId)).map(safeConnection);
    return NextResponse.json({
      timestamp: new Date().toISOString(),
      db_ready: dbReady(),
      env,
      connections,
      ready: Object.values(env).some(Boolean),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.provider) return badRequest('provider is required');
    const row = await upsertConnection({
      account_id: session.accountId,
      provider: String(body.provider),
      status: body.status,
      secret_ref: body.secret_ref ?? null,
      meta: body.meta ?? {},
    });
    return NextResponse.json(row, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/integrations", method: "GET" });
export const POST = withApi(POST__impl as any, { route: "/api/integrations", method: "POST" });
