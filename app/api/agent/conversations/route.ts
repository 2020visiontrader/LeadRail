import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listConversationsForAccount } from '@/lib/agent/memory';

export const dynamic = 'force-dynamic';

// GET /api/agent/conversations — recent chats for the session's account, newest
// first, for the assistant dock's history list.
//
// Returns ONLY {id, title, updated_at, token_estimate}. No transcript: the list
// renders on every dock open and transcripts are unbounded. Rehydration fetches
// one transcript at a time from /api/agent/conversations/:id.
//
// Account scope is ALWAYS the session's, applied inside the query by
// listConversationsForAccount — never derived from the request.
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const raw = request.nextUrl.searchParams.get('limit');
    const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : 30;
    const conversations = await listConversationsForAccount(session.accountId, limit);
    return NextResponse.json({ conversations });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations', method: 'GET' });
