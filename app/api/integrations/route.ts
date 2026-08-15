import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { dbReady, getConnections, upsertConnection } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    // Backend env status (which platform services are configured) is owner-only —
    // clients must never learn the tech stack. Per-account connections stay visible.
    const isOwner = session.role === 'owner';
    const env = isOwner ? getIntegrationStatus() : {};
    let connections: any[] = [];
    if (dbReady()) connections = await getConnections(session.accountId);
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
