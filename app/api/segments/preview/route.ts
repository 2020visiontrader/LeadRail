import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { previewSegment } from '@/lib/segments/store';

export const dynamic = 'force-dynamic';

// POST /api/segments/preview — { filters } → { count, sample }. Lets the
// builder UI show a live match count before the segment is saved.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ count: 0, sample: [] });
  try {
    const body = await request.json();
    const filters = Array.isArray(body?.filters) ? body.filters : [];
    const result = await previewSegment(session.accountId, filters);
    return NextResponse.json(result);
  } catch (e: any) {
    if (e?.message && /field|op|value/i.test(e.message)) return badRequest(e.message);
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/segments/preview', method: 'POST' });
