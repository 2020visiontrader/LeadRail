import { withApi, requireSession, badRequest, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { truncateConversationAt } from '@/lib/agent/memory';
import { revokeAllForConversation } from '@/lib/approvals/grants';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// POST /api/agent/conversations/:id/rerun — the server-side half of both
// "edit a message" and "retry a message": drop `messageId` and everything
// after it from the stored transcript, so the client's next ordinary POST
// /api/agent(/stream) call (sending the edited or original text as a fresh
// user message) appends onto a conversation that no longer contains the
// turn being replaced.
//
// Body: { messageId } — for an EDIT, the user message being edited (its own
// old text and everything after it is dropped, then the client sends the new
// text). For a RETRY, the user message that preceded the assistant reply
// being retried (same drop, then the client resends that message's original
// text unchanged). Both reduce to the same primitive: the client already
// knows which id to name; this route does not need to distinguish the two.
//
// RETRY SAFETY (read lib/approvals/grants.ts's header first). Re-running a
// turn re-runs its TOOLS. If the turn being discarded called a tool gated
// `external_send` or `spend` (sendEmail, enrichLead, ...) UNDER A STANDING
// GRANT (lib/approvals/grants.ts, migration 062) — "approve enrichLead for
// this whole conversation" — that grant is still live and still scoped to
// THIS conversation_id. Truncating the transcript does nothing to it: the
// rerun would walk straight back into runTool, find the same live grant, and
// auto-approve the SAME action again with no human back in the loop. That is
// exactly how a retry silently double-sends a real email.
//
// THE DECISION: revoke every live grant for this conversation, unconditionally,
// before the truncate takes effect, whenever a rerun is requested. Not scoped
// to "only if the discarded turn actually used a tool" — the transcript is
// role/content jsonb (lib/agent/transcript-store.ts), not a structured tool
// trace, so "did the turn about to be discarded call a sensitive tool" is not
// reliably answerable outside lib/agent/loop.ts, which this Packet is
// forbidden from touching (a concurrent agent owns it). Revoking unconditionally
// is the safe direction: the worst case is a rerun that re-asks for a
// permission that would have been harmless to reuse; the alternative's worst
// case is a second real email. A rerun turn NEEDING a sensitive tool again
// re-raises the approval card, exactly like the first time the human saw it —
// never silently re-executes. This is a full account-conversation revoke
// (lib/approvals/grants.ts revokeAllForConversation), not tool-scoped, for the
// same reason: no reliable signal here says which tool(s) the discarded turn
// used, so nothing narrower can be trusted to cover it.
async function POST__impl(request: NextRequest, { params }: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const messageId = typeof body?.messageId === 'string' && body.messageId ? body.messageId : undefined;
  if (!messageId) return badRequest('messageId is required');

  try {
    // Revoke BEFORE the truncate is even attempted: if the truncate then
    // fails (unknown conversation, wrong account, unknown messageId), the
    // caller aborts the rerun entirely and nothing is resent — a
    // conversation with its grants revoked but nothing else changed is a
    // no-op the operator can simply re-approve, which is a far cheaper
    // mistake than the reverse ordering (truncate first, then fail to
    // revoke and rerun anyway).
    const revoked = await revokeAllForConversation(session.accountId, params.id);
    if (revoked > 0) {
      log.info('agent rerun: revoked standing grants ahead of edit/retry', {
        conversationId: params.id, revoked,
      });
    }

    const transcript = await truncateConversationAt(session.accountId, params.id, messageId);
    if (!transcript) return badRequest('could not rerun from that message');
    return NextResponse.json({ ok: true, transcript });
  } catch (e) {
    return errorResponse(e);
  }
}

export const POST = withApi(POST__impl as any, { route: '/api/agent/conversations/[id]/rerun', method: 'POST' });
