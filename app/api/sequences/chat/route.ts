import { NextRequest, NextResponse } from 'next/server';
import { requireSession, errorResponse, badRequest } from '@/lib/http';
import { sequenceChat } from '@/lib/ai/generation';
import { opencodeConfigured, type ChatMessage } from '@/lib/ai/opencode';

export const dynamic = 'force-dynamic';

// Multi-turn sequence builder. Body: { messages: [{role,content}], ventureName }.
export async function POST(request: NextRequest) {
  const { error } = await requireSession(request);
  if (error) return error;
  if (!opencodeConfigured()) return NextResponse.json({ error: 'not_configured', provider: 'opencode' }, { status: 409 });
  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }
  const messages: ChatMessage[] = Array.isArray(body?.messages) ? body.messages : [];
  if (!messages.length) return badRequest('messages array is required');
  try {
    const result = await sequenceChat(messages, { ventureName: body?.ventureName });
    return NextResponse.json(result);
  } catch (e: any) {
    if (e?.code === 'auth') return NextResponse.json({ error: 'opencode_auth_failed' }, { status: 502 });
    return errorResponse(e);
  }
}
