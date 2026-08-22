import { requireSession, badRequest } from '@/lib/http';
import { NextRequest } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgentStream, agentConfigured, generateCarryover, type AgentEvent } from '@/lib/agent/loop';
import { loadAgentContext } from '@/lib/agent/context';
import { saveConversation, loadCarryover, loadTranscript, ingestCarryoverFacts } from '@/lib/agent/memory';
import { parseMentions } from '@/lib/agent/personas';
import type { ChatMessage } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// POST /api/agent/stream — same executor as /api/agent, streamed as SSE so the
// UI renders each thinking/tool step live. Body: { message?, brandId?, conversationId?, approve? }.
// The client NEVER sends transcript content (Packet 0.2) — the server loads it
// for the supplied conversationId, so client-supplied text can never reach the
// model's message array.
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
  // approvalId is REQUIRED (Packet 0.1) — execution is gated on a persisted
  // approvals row, so a resume without one is refused rather than executed.
  const approve = body?.approve && typeof body.approve === 'object'
    && typeof body.approve.tool === 'string' && typeof body.approve.approvalId === 'string' && body.approve.approvalId
    ? {
        approvalId: body.approve.approvalId as string,
        tool: body.approve.tool as string,
        args: (body.approve.args && typeof body.approve.args === 'object') ? body.approve.args : {},
      }
    : undefined;
  if (!message && !approve) return badRequest('provide a message, or an approved action including its approvalId');
  if (typeof message === 'string' && message.length > 8000) return badRequest('message too long');

  let brandId: string | undefined;
  let brandName: string | undefined;
  if (typeof body?.brandId === 'string' && body.brandId) {
    const { data } = await supabase.from('brands')
      .select('id, name').eq('id', body.brandId).eq('account_id', session.accountId).maybeSingle();
    if (data?.id) { brandId = data.id; brandName = data.name || undefined; }
  }

  const fromId = typeof body?.from === 'string' && body.from ? body.from : undefined;
  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;
  // Server-owned conversation state, scoped to this session's account. An id
  // from another account (or an unknown one) yields [] — not an error, not
  // their data. This is also the approve-resume path's context source.
  const transcript = await loadTranscript(conversationId, session.accountId);
  const carryover = fromId ? await loadCarryover(fromId, session.accountId) : null;
  const agentContext = await loadAgentContext({ accountId: session.accountId, brandId, brandName, query: message });

  // Optional persona routing (migration 024) — no-op unless the client opts in.
  const personaId: string | undefined = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined;
  const personaMentions = parseMentions(message);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      let finalTranscript: ChatMessage[] | undefined;
      // Set from the trailing compaction_suggested event (emitted after `final`),
      // so the finally block below knows whether this turn hit a compaction
      // threshold. Null on every ordinary turn.
      let compaction: 'soft' | 'hard' | null = null;
      try {
        await runAgentStream(
          { accountId: session.accountId, message, approve, transcript, agentContext, carryover, brandContext: (brandId || brandName) ? { id: brandId, name: brandName } : undefined, personaId, personaMentions, requestedBy: session.email, conversationId },
          (e: AgentEvent) => {
            // Only `final`/`needs_approval` carry a transcript. Everything else,
            // including `final_delta` (a progressive preview of the answer being
            // written), passes straight through unfiltered and unpersisted.
            if (e.type === 'final' || e.type === 'needs_approval') finalTranscript = e.transcript;
            if (e.type === 'compaction_suggested') compaction = e.level;
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

          // Passive memory extraction (Packet 1.1) — mirrors /api/agent. Only
          // on a compaction event (once per long chat, not per message), and
          // fire-and-forget: the stream closes immediately below regardless.
          if (compaction === 'soft' || compaction === 'hard') {
            const t = finalTranscript;
            void generateCarryover(t)
              .then((memo) => ingestCarryoverFacts(session.accountId, memo))
              .catch(() => { /* best-effort */ });
          }
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
