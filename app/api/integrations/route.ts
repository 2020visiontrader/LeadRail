import { NextRequest, NextResponse } from 'next/server';
import { getIntegrationStatus } from '@/lib/integrations/env';
import { dbReady, getConnections, upsertConnection } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const env = getIntegrationStatus();
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

export async function POST(request: NextRequest) {
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
