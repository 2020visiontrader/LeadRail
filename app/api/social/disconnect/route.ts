import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { deleteConnection } from '@/lib/db';
export const dynamic = 'force-dynamic';

// Disconnect one connected social account. Account-scoped via the session, so a
// user can only remove their own connections. externalId targets a single account
// when several exist on the same platform.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const body = await request.json().catch(() => ({}));
    const provider = body?.provider as string | undefined;
    const externalId = body?.externalId as string | undefined;
    if (!provider) return badRequest('provider is required');
    const result = await deleteConnection(session.accountId, provider, externalId);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/social/disconnect', method: 'POST' });
