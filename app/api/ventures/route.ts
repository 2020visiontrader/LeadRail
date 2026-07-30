import { NextRequest, NextResponse } from 'next/server';
import { getVentures, createVenture, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/ventures — ventures (brands) for the caller's account only.
export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json({ ventures: [], db_ready: false });
  try {
    const ventures = await getVentures(session.accountId);
    return NextResponse.json({ ventures, db_ready: true });
  } catch (error) {
    return errorResponse(error);
  }
}

// POST /api/ventures — create a new venture (brand) for the caller's account.
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not configured');
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || '').trim();
    if (!name) return badRequest('name is required');
    const venture = await createVenture(session.accountId, name);
    return NextResponse.json({ venture }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
