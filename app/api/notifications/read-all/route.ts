import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse } from '@/lib/http';
import { markAllRead } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

// POST /api/notifications/read-all — mark every unread notification read.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const result = await markAllRead(session.accountId);
    return NextResponse.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/notifications/read-all', method: 'POST' });
