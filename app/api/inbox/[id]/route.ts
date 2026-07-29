import { NextRequest, NextResponse } from 'next/server';
import { markInboxRead, dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json().catch(() => ({}));
    return NextResponse.json(await markInboxRead(ctx.params.id, session.accountId, body?.is_read ?? true));
  } catch (error) {
    return errorResponse(error);
  }
}
