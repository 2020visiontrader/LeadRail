import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { listConversationsForAccount } from '@/lib/agent/memory';

export const dynamic = 'force-dynamic';

// GET /api/agent/conversations — recent chats for the session's account, newest
// first, for the assistant dock's history list.
//
// Returns {conversations, nextCursor}. Cursor-paginated on updated_at and
// optionally filtered by ?q= against the title.
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
    const params = request.nextUrl.searchParams;
    const raw = params.get('limit');
    const limit = raw && Number.isFinite(Number(raw)) ? Number(raw) : 30;
    // `cursor` is the previous page's nextCursor — an updated_at, not an
    // offset. See listConversationsForAccount for why.
    const cursor = params.get('cursor');
    const search = params.get('q');
    const page = await listConversationsForAccount(session.accountId, limit, cursor, search);
    return NextResponse.json(page);
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations', method: 'GET' });
