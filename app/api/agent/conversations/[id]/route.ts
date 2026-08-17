import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { loadConversation } from '@/lib/agent/memory';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse, badRequest } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return badRequest('database not connected');
  try {
    const convo = await loadConversation(ctx.params.id, session.accountId);
    if (!convo) return NextResponse.json({ error: 'not found' }, { status: 404 });
    return NextResponse.json({ id: convo.id, title: convo.title, transcript: convo.transcript || [] });
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations/[id]', method: 'GET' });
