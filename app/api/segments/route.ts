import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { listSegments, createSegment } from '@/lib/segments/store';

export const dynamic = 'force-dynamic';

// GET /api/segments — list this account's segments.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ segments: [] });
  try {
    const segments = await listSegments(session.accountId);
    return NextResponse.json({ segments });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/segments — create a segment. account_id always comes from the
// session, never the client body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json();
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const segment = await createSegment(session.accountId, {
      name,
      description: body?.description ? String(body.description) : undefined,
      filters: Array.isArray(body?.filters) ? body.filters : undefined,
    });
    return NextResponse.json(segment, { status: 201 });
  } catch (e: any) {
    if (e?.message && /field|op|value/i.test(e.message)) return badRequest(e.message);
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/segments', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/segments', method: 'POST' });
