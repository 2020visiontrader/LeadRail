import { NextRequest, NextResponse } from 'next/server';
import { listConversations } from '@/lib/conversations';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '50', 10), 200);
    return NextResponse.json(await listConversations(session.accountId, limit));
  } catch (error) {
    return errorResponse(error);
  }
}
