import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { inboxReplyChat } from '@/lib/ai/generation';
import { geminiConfigured, type ChatMessage } from '@/lib/ai/gemini';

export const dynamic = 'force-dynamic';

// Multi-turn inbox reply assistant.
// Body: { messages: [{role,content}], context: { incomingSubject, incomingBody, fromName, ventureName } }.
export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  if (!geminiConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'gemini' }, { status: 409 });
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return badRequest('messages array is required');
  try {
    const result = await inboxReplyChat(messages, body?.context || {});
    return NextResponse.json(result);
  } catch (e: any) {
    if (e?.code === 'auth') return NextResponse.json({ error: 'gemini_auth_failed' }, { status: 502 });
    return errorResponse(e);
  }
}
