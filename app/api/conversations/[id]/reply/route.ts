import { withApi } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { getConversation, recordConversationMessage } from '@/lib/conversations';
import { replyToComment, sendInstagramMessage } from '@/lib/social/meta-engagement';

export const dynamic = 'force-dynamic';

// Reply to a conversation from LeadRail. Instagram only for now: replies to the
// most recent inbound comment via the comment API, or DMs the most recent
// inbound sender via the Instagram Send API — whichever the thread last had.
async function POST__impl(request: NextRequest, ctx: { params: { id: string } }) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const text: string | undefined = body?.body;
  if (!text) return badRequest('body is required');

  try {
    const conversation: any = await getConversation(ctx.params.id, session.accountId);
    if (!conversation) return badRequest('conversation not found');
    if (conversation.channel !== 'instagram') {
      return badRequest('reply is only supported for instagram conversations right now');
    }

    const messages: any[] = conversation.messages || [];
    const lastInbound = [...messages].reverse().find((m) => m.direction === 'inbound');
    if (!lastInbound) return badRequest('no inbound message to reply to yet');

    const isComment = lastInbound.meta?.kind === 'comment';
    // Resolve the exact IG connection this thread came from — an account with
    // more than one connected Instagram business account must reply from the
    // same one, not whichever connection happens to be most-recently-updated.
    const igAccountId: string | undefined = lastInbound.meta?.igAccountId;
    const result = isComment
      ? await replyToComment(session.accountId, lastInbound.external_id, text, 'instagram', igAccountId)
      : await sendInstagramMessage(session.accountId, lastInbound.from_addr, text, igAccountId);

    await recordConversationMessage({
      accountId: session.accountId,
      channel: 'instagram',
      direction: 'outbound',
      threadKey: conversation.external_thread_id,
      toAddr: lastInbound.from_addr ?? null,
      body: text,
      meta: { raw: result, kind: isComment ? 'comment' : undefined, igAccountId },
    });

    return NextResponse.json({ success: true, result });
  } catch (e: any) {
    return errorResponse(e);
  }
}

// --- request logging (auto-wrapped) ---
export const POST = withApi(POST__impl as any, { route: "/api/conversations/[id]/reply", method: "POST" });
