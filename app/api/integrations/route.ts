import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { dbReady, getConnections, upsertConnection } from '@/lib/db';
import { requireAuth, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/integrations[?accountId=...]
// Always returns env-level availability; if accountId + db are present,
// also returns the per-account connection rows.
export async function GET(request: NextRequest) {
  try {
    const env = getIntegrationStatus();
    const accountId = request.nextUrl.searchParams.get('accountId');
    let connections: any[] = [];
    if (accountId && dbReady()) connections = await getConnections(accountId);
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

// POST /api/integrations — upsert a connection row.
// body: { accountId, provider, status?, secret_ref?, meta? }
export async function POST(request: NextRequest) {
  const unauthorized = requireAuth(request);
  if (unauthorized) return unauthorized;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    if (!body?.accountId || !body?.provider) return badRequest('accountId and provider are required');
    const row = await upsertConnection({
      account_id: body.accountId,
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
