import { withApi, requireSession, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { generateCarryover } from '@/lib/agent/loop';
import { loadConversation, saveCarryover } from '@/lib/agent/memory';

export const dynamic = 'force-dynamic';

// POST /api/agent/carryover — long-chat handoff.
// Body: { conversationId }. Distills the stored transcript into a compact
// carryover memo, saves it on the conversation, and returns it. The client then
// opens a fresh chat with ?from=<conversationId>, which seeds it from this memo.
// Account scope is ALWAYS the session's.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const conversationId = typeof body?.conversationId === 'string' ? body.conversationId : '';
  if (!conversationId) return badRequest('conversationId is required');

  const convo = await loadConversation(conversationId, session.accountId);
  if (!convo) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

  // If already compacted, return the existing memo (idempotent, no extra model call).
  if (convo.carryover) {
    return NextResponse.json({ conversationId, carryover: convo.carryover, reused: true });
  }

  const transcript = Array.isArray(convo.transcript) ? convo.transcript : [];
  const carryover = await generateCarryover(transcript);
  await saveCarryover(conversationId, session.accountId, carryover);

  return NextResponse.json({ conversationId, carryover });
}

export const POST = withApi(POST__impl as any, { route: '/api/agent/carryover', method: 'POST' });
