import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { markRead } from '@/lib/notifications/store';

export const dynamic = 'force-dynamic';

// PATCH /api/notifications/:id — mark one notification read.
async function PATCH__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const notification = await markRead(session.accountId, params.id);
    return NextResponse.json(notification);
  } catch (e: any) {
    if (e?.message === 'notification not found') return badRequest('unknown notification');
    return errorResponse(e);
  }
}

export const PATCH = withApi(PATCH__impl as any, { route: '/api/notifications/[id]', method: 'PATCH' });
