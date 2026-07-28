import { NextRequest, NextResponse } from 'next/server';
import { getVentures } from '@/lib/db';
import { dbReady } from '@/lib/db';
import { errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/ventures?accountId=... — ventures (brands) for the account.
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId') || undefined;
  if (!dbReady()) return NextResponse.json({ ventures: [], db_ready: false });
  try {
    // accountId optional: admin (single-tenant) gets all ventures; each row
    // carries account_id so the client can scope search/import without hardcoding.
    const ventures = await getVentures(accountId);
    return NextResponse.json({ ventures, db_ready: true });
  } catch (error) {
    return errorResponse(error);
  }
}
