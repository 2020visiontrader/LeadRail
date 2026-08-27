import { withApi, requireSession, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { loadTranscript, deleteConversation } from '@/lib/agent/memory';
import { pendingApprovalForConversation } from '@/lib/approvals/store';

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
    // The pending approval comes back WITH the transcript so returning to a
    // chat re-surfaces the card inline, rather than leaving the proposal
    // reachable only from the approval queue. Never fails the read: a chat that
    // loads without its approval is far better than one that does not load.
    const [transcript, pendingApproval] = await Promise.all([
      loadTranscript(params.id, session.accountId),
      pendingApprovalForConversation(session.accountId, params.id).catch(() => null),
    ]);
    return NextResponse.json({ id: params.id, transcript, pendingApproval });
  } catch (e) {
    return errorResponse(e);
  }
}

// DELETE /api/agent/conversations/:id — soft-delete (migration 069). The chat
// disappears from the history list and from the transcript read immediately;
// hard-purged after the retention window (DEFAULT_GRACE_DAYS, lib/privacy.ts)
// once the retention scheduler exists to run purge_soft_deleted (see
// BACKLOG.md §2 — not yet).
//
// Account scope is ALWAYS the session's, applied inside deleteConversation's
// query, never derived from the request. Deleting an id belonging to another
// account must be indistinguishable from deleting an unknown id — same as the
// GET handler's comment above: this must not become an existence oracle. So
// the response never varies with WHY nothing matched (unknown id, someone
// else's id, or already deleted) — only with whether ok is a boolean the
// caller can safely ignore either way.
async function DELETE__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  try {
    const deleted = await deleteConversation(session.accountId, params.id);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const GET = withApi(GET__impl as any, { route: '/api/agent/conversations/[id]', method: 'GET' });
export const DELETE = withApi(DELETE__impl as any, { route: '/api/agent/conversations/[id]', method: 'DELETE' });
