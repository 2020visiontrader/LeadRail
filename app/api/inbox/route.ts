import { NextRequest, NextResponse } from 'next/server';
import { getInbox, dbReady } from '@/lib/db';
import { errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

// GET /api/inbox?accountId=...
export async function GET(request: NextRequest) {
  const accountId = request.nextUrl.searchParams.get('accountId');
  if (!accountId) return badRequest('accountId is required');
  if (!dbReady()) return NextResponse.json([]);
  try {
    return NextResponse.json(await getInbox(accountId));
  } catch (error) {
    return errorResponse(error);
  }
}
