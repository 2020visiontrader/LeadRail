import { NextRequest, NextResponse } from 'next/server';
import { getContactTimeline } from '@/lib/timeline';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '100', 10), 200);
    return NextResponse.json({ timeline: await getContactTimeline(session.accountId, params.id, limit) });
  } catch (e) {
    return errorResponse(e);
  }
}
