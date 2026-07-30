import { NextRequest, NextResponse } from 'next/server';
import { getConversation, markConversationRead, setConversationStatus } from '@/lib/conversations';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    return NextResponse.json(await getConversation(ctx.params.id, session.accountId));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const body = await request.json().catch(() => ({}));
    if (body?.status) return NextResponse.json(await setConversationStatus(ctx.params.id, session.accountId, body.status));
    return NextResponse.json(await markConversationRead(ctx.params.id, session.accountId, body?.is_read ?? true));
  } catch (error) {
    return errorResponse(error);
  }
}
