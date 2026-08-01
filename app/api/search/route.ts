import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { searchEntities } from '@/lib/search';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const q = request.nextUrl.searchParams.get('q') || '';
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '20', 10), 50);
    return NextResponse.json(await searchEntities(session.accountId, q, limit));
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: "/api/search", method: "GET" });
