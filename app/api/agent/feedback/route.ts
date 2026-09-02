import { withApi, requireSession, badRequest, errorResponse } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { loadConversation } from '@/lib/agent/memory';
import { recordMessageFeedback, listFeedbackForConversation } from '@/lib/agent/feedback';

export const dynamic = 'force-dynamic';

// GET /api/agent/feedback?conversationId=... — this account's existing votes
// for a conversation, keyed by message_id, so the console can paint the
// thumb that's already recorded after a reload.
//
// Account scope is ALWAYS the session's: loadConversation is called first and
// its account_id filter means a conversationId belonging to another account
// (or an unknown one) reads as "no such conversation" here too — same
// no-existence-oracle rule every other conversation-scoped route in this repo
// follows (see app/api/agent/conversations/[id]/route.ts).
async function GET__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  const conversationId = request.nextUrl.searchParams.get('conversationId') || '';
  if (!conversationId) return badRequest('conversationId is required');
  try {
    const convo = await loadConversation(conversationId, session.accountId);
    if (!convo) return NextResponse.json({ feedback: {} });
    const feedback = await listFeedbackForConversation(session.accountId, conversationId);
    return NextResponse.json({ feedback });
  } catch (e) {
    return errorResponse(e);
  }
}

// POST /api/agent/feedback — record or change a vote on one message.
// Body: { conversationId, messageId, up: boolean, personaId? }
//
// Account scope is ALWAYS the session's. The conversation is loaded first
// (account-scoped) and the target message_id must actually appear in ITS
// transcript — a vote cannot be attached to a message that was never part of
// a conversation this account owns, even one that happens to guess a real
// message_id from another tenant's chat (StoredMessage.id is a random UUID,
// but this check costs nothing and removes the guess entirely).
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }

  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;
  const messageId = typeof body?.messageId === 'string' && body.messageId ? body.messageId : undefined;
  const up = typeof body?.up === 'boolean' ? body.up : undefined;
  const personaId = typeof body?.personaId === 'string' && body.personaId ? body.personaId : null;
  if (!conversationId || !messageId || up === undefined) {
    return badRequest('conversationId, messageId, and up (boolean) are required');
  }

  try {
    const convo = await loadConversation(conversationId, session.accountId);
    if (!convo) return badRequest('no such conversation');
    const hasMessage = Array.isArray(convo.transcript) && convo.transcript.some((m: any) => m?.id === messageId);
    if (!hasMessage) return badRequest('no such message in this conversation');

    const feedback = await recordMessageFeedback({
      accountId: session.accountId,
      conversationId,
      messageId,
      up,
      personaId,
      votedBy: session.email,
    });
    if (!feedback) return errorResponse(new Error('write failed'), 500, 'Could not record that vote just now');
    return NextResponse.json({ feedback });
  } catch (e) {
    return errorResponse(e);
  }
}

export const GET = withApi(GET__impl as any, { route: '/api/agent/feedback', method: 'GET' });
export const POST = withApi(POST__impl as any, { route: '/api/agent/feedback', method: 'POST' });
