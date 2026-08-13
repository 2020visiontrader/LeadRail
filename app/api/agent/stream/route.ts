import { requireSession, badRequest } from '@/lib/http';
import { NextRequest } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgentStream, agentConfigured, type AgentEvent } from '@/lib/agent/loop';
import { loadAgentContext } from '@/lib/agent/context';
import { saveConversation, loadCarryover } from '@/lib/agent/memory';
import { parseMentions } from '@/lib/agent/personas';
import type { ChatMessage } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// POST /api/agent/stream — same executor as /api/agent, streamed as SSE so the
// UI renders each thinking/tool step live. Body: { message?, brandId?, transcript?, approve? }.
// Account scope is ALWAYS the session's. Not withApi-wrapped (that buffers JSON).
export async function POST(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;
  if (!agentConfigured()) {
    return new Response(JSON.stringify({ error: 'LeadRail AI is temporarily unavailable', code: 'not_configured' }), {
      status: 409, headers: { 'Content-Type': 'application/json' },
    });
  }

  let body: any;
  try { body = await request.json(); } catch { return badRequest('invalid JSON body'); }

  const message: string | undefined = typeof body?.message === 'string' ? body.message : undefined;
  const approve = body?.approve && typeof body.approve === 'object' && typeof body.approve.tool === 'string'
    ? { tool: body.approve.tool as string, args: (body.approve.args && typeof body.approve.args === 'object') ? body.approve.args : {} }
    : undefined;
  if (!message && !approve) return badRequest('provide a message or an approved action');

  const transcript: ChatMessage[] = Array.isArray(body?.transcript)
    ? body.transcript.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

  let brandId: string | undefined;
  let brandName: string | undefined;
  if (typeof body?.brandId === 'string' && body.brandId) {
    const { data } = await supabase.from('brands')
      .select('id, name').eq('id', body.brandId).eq('account_id', session.accountId).maybeSingle();
    if (data?.id) { brandId = data.id; brandName = data.name || undefined; }
  }

  const fromId = typeof body?.from === 'string' && body.from ? body.from : undefined;
  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;
  const carryover = fromId ? await loadCarryover(fromId, session.accountId) : null;
  const agentContext = await loadAgentContext({ accountId: session.accountId, brandId, brandName });

  // Optional persona routing (migration 024) — no-op unless the client opts in.
  const personaId: string | undefined = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined;
  const personaMentions = parseMentions(message);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      let finalTranscript: ChatMessage[] | undefined;
      try {
        await runAgentStream(
          { accountId: session.accountId, message, approve, transcript, agentContext, carryover, brandContext: brandName ? { name: brandName } : undefined, personaId, personaMentions, requestedBy: session.email, conversationId },
          (e: AgentEvent) => {
            if (e.type === 'final' || e.type === 'needs_approval') finalTranscript = e.transcript;
            send(e);
          },
        );
      } catch (e: any) {
        send({ type: 'error', message: e?.message || 'Agent failed' });
      } finally {
        // Persist the conversation and tell the client its id so follow-up turns
        // and the carryover handoff can reference it.
        if (finalTranscript) {
          const savedId = await saveConversation({
            id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
            title: typeof message === 'string' ? message.slice(0, 80) : undefined,
            transcript: finalTranscript,
          });
          send({ type: 'conversation', conversationId: savedId ?? conversationId });
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
