import { NextRequest, NextResponse } from 'next/server';
import { getVentures, dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

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
