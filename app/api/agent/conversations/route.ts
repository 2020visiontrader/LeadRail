import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listAgentConversations } from '@/lib/agent/memory';
import { dbReady } from '@/lib/db';
import { requireSession, errorResponse } from '@/lib/http';

export const dynamic = 'force-dynamic';

async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!dbReady()) return NextResponse.json([]);
  try {
    const limit = Math.min(parseInt(request.nextUrl.searchParams.get('limit') || '30', 10), 100);
    return NextResponse.json(await listAgentConversations(session.accountId, limit));
  } catch (error) {
    return errorResponse(error);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations', method: 'GET' });
