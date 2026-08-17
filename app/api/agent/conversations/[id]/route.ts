import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { loadTranscript } from '@/lib/agent/memory';

export const dynamic = 'force-dynamic';

// GET /api/agent/conversations/:id — the stored transcript, so the browser can
// repaint prior turns after a refresh. (The server already reloads it for the
// model on every turn — packet 0.2 — so this closes a UI gap, not a data one.)
//
// Account scope is ALWAYS the session's: loadTranscript wraps loadConversation,
// which filters on account_id IN THE QUERY. An id belonging to another account
// returns exactly what an unknown id returns — an empty transcript, HTTP 200 —
// so this route is not an existence oracle.
async function GET__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const transcript = await loadTranscript(params.id, session.accountId);
    return NextResponse.json({ id: params.id, transcript });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations/[id]', method: 'GET' });
