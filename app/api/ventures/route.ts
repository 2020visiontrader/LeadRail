import { NextRequest, NextResponse } from 'next/server';
import { getVentures } from '@/lib/db';
import { dbReady } from '@/lib/db';
import { errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/ventures?accountId=... — ventures (brands) for the account.
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  if (!accountId) return badRequest('accountId is required');
  if (!dbReady()) return NextResponse.json({ ventures: [], db_ready: false });
  try {
    const ventures = await getVentures(accountId);
    return NextResponse.json({ ventures, db_ready: true });
  } catch (error) {
    return errorResponse(error);
  }
}
