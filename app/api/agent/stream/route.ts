import { requireSession, badRequest } from '@/lib/http';
import { NextRequest } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgentStream, agentConfigured, type AgentEvent } from '@/lib/agent/loop';
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

  let brandName: string | undefined;
  if (typeof body?.brandId === 'string' && body.brandId) {
    const { data } = await supabase.from('brands')
      .select('name').eq('id', body.brandId).eq('account_id', session.accountId).maybeSingle();
    if (data?.name) brandName = data.name;
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: AgentEvent) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      try {
        await runAgentStream(
          { accountId: session.accountId, message, approve, transcript, brandContext: brandName ? { name: brandName } : undefined },
          send,
        );
      } catch (e: any) {
        send({ type: 'error', message: e?.message || 'Agent failed' });
      } finally {
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
