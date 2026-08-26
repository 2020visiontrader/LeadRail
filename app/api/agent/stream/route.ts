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
  // `let`, not `const`: the opening save below mints an id for a brand-new
  // conversation, and everything after it must use that id rather than undefined.
  let conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;

  // Optional persona routing (migration 024) — no-op unless the client opts in.
  const personaId: string | undefined = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined;
  const personaMentions = parseMentions(message);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (e: any) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
      // Fire the instant the connection opens — before any DB work starts.
      // Loading transcript/carryover/agentContext below used to run BEFORE the
      // Response (and therefore the stream) was even returned, so the client's
      // fetch() didn't resolve res.body until all of it finished: several
      // sequential DB round-trips, one of which calls an embedding API. That
      // produced the blank-pane symptom — "Send (1 running)" with nothing
      // rendering until the model's first real event, sometimes seconds later.
      // This line guarantees the UI shows motion within the connection's own
      // round-trip time, independent of how long context assembly takes.
      // This exists to prove the connection is alive within its own round-trip
      // time, NOT to report on itself. "Loading your workspace context" told the
      // operator about our plumbing every single turn — the assistant is
      // supposed to already know their workspace, so announcing that it is
      // fetching it reads as slower and less capable, not more transparent.
      // Says what is happening to THEM instead.
      send({ type: 'step_start', text: 'Thinking…' });
      // Whether the client has been told the turn is OVER. A stream that closes
      // without one of these leaves the UI running forever: the reader loop ends
      // so the run is released, but no step ever resolves — which is exactly the
      // "(1 running) disappears while the trace still says Running" state.
      let terminalSent = false;
      let finalTranscript: ChatMessage[] | undefined;
      // Set from the trailing compaction_suggested event (emitted after `final`),
      // so the finally block below knows whether this turn hit a compaction
      // threshold. Null on every ordinary turn.
      let compaction: 'soft' | 'hard' | null = null;
      // The transcript this turn STARTED from, plus the user's message. Held so
      // the finally block can persist something even when the turn never
      // reaches a terminal event — see the save below.
      let openingTranscript: ChatMessage[] | undefined;
      try {
        // Server-owned conversation state, scoped to this session's account. An
        // id from another account (or an unknown one) yields [] — not an error,
        // not their data. This is also the approve-resume path's context source.
        // These three are independent reads — fetched concurrently now that
        // they're inside the stream, instead of serially blocking the response.
        const [transcript, carryover, agentContext] = await Promise.all([
          loadTranscript(conversationId, session.accountId),
          fromId ? loadCarryover(fromId, session.accountId) : Promise.resolve(null),
          loadAgentContext({ accountId: session.accountId, brandId, brandName, query: message, conversationId }),
        ]);
        // WHAT THE PERSON SAID IS DURABLE FROM HERE, whatever happens next.
        //
        // Previously the conversation was saved ONLY on a terminal event, so a
        // turn that errored, was stopped, or threw saved nothing at all — and
        // the user's own message vanished with it. Losing the assistant's half
        // of a failed turn is tolerable; losing what the person typed is not,
        // because only they can reproduce it.
        if (typeof message === 'string' && message.trim()) {
          openingTranscript = [...transcript, { role: 'user', content: message } as ChatMessage];
          const openedId = await saveConversation({
            id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
            title: message.slice(0, 80),
            transcript: openingTranscript,
          }).catch(() => null);
          // Tell the client its id NOW rather than at the end, so a turn that
          // dies mid-flight still leaves a conversation it can return to.
          if (openedId) {
            conversationId = openedId;
            send({ type: 'conversation', conversationId: openedId });
          }
        }

        await runAgentStream(
          { accountId: session.accountId, message, approve, transcript, agentContext, carryover, brandContext: (brandId || brandName) ? { id: brandId, name: brandName } : undefined, personaId, personaMentions, requestedBy: session.email, conversationId },
          (e: AgentEvent) => {
            // Only `final`/`needs_approval` carry a transcript. Everything else,
            // including `final_delta` (a progressive preview of the answer being
            // written), passes straight through unfiltered and unpersisted.
            if (e.type === 'final' || e.type === 'needs_approval') {
              finalTranscript = e.transcript;
              terminalSent = true;
            }
            if (e.type === 'error') terminalSent = true;
            if (e.type === 'compaction_suggested') compaction = e.level;
            send(e);
          },
        );
      } catch (e: any) {
        send({ type: 'error', message: e?.message || 'Agent failed' });
        terminalSent = true;
      } finally {
        // THE GUARANTEE: this stream never closes silently.
        //
        // A turn could complete its work and then fail on the way out — the
        // logs showed exactly that, an inner turn logging "done" while the
        // outer stream logged "threw" one second later. Whatever the cause,
        // the client was left with a spinner and no explanation, which is the
        // worst possible outcome: indistinguishable from still working.
        //
        // Enforced HERE rather than in the client because the server is the
        // only party that knows a turn ended. A client-side timeout would have
        // to guess, and would eventually give up on a turn that was fine.
        if (!terminalSent) {
          send({
            type: 'error',
            message: 'That turn ended without producing an answer. Nothing was sent or charged. Try again — if it repeats, the model provider is likely failing.',
          });
        }
        // Persist the conversation and tell the client its id so follow-up turns
        // and the carryover handoff can reference it.
        // Save the fullest transcript this turn produced. `finalTranscript` when
        // the turn completed; otherwise the opening one, which at least keeps
        // the user's message. The old code saved nothing in the second case.
        const toSave = finalTranscript ?? openingTranscript;
        if (toSave) {
          const savedId = await saveConversation({
            id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
            title: typeof message === 'string' ? message.slice(0, 80) : undefined,
            transcript: toSave,
          });
          send({ type: 'conversation', conversationId: savedId ?? conversationId });

          // Passive memory extraction (Packet 1.1) — mirrors /api/agent. Only
          // on a compaction event (once per long chat, not per message), and
          // fire-and-forget: the stream closes immediately below regardless.
          // Only on a COMPLETED turn: extracting durable facts from a
          // half-finished exchange would learn from work that never happened.
          if (finalTranscript && (compaction === 'soft' || compaction === 'hard')) {
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
