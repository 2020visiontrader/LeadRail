import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { recordEvent } from '@/lib/analytics/store';

export const dynamic = 'force-dynamic';

// POST /api/events — record one event for this account. account_id always
// comes from the session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const type = String(body?.type || '').trim();
    if (!type) return badRequest('type is required');
    const event = await recordEvent(session.accountId, {
      type,
      contactId: body?.contactId ? String(body.contactId) : undefined,
      props: body?.props && typeof body.props === 'object' ? body.props : undefined,
    });
    return NextResponse.json(event, { status: 201 });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/events', method: 'POST' });
