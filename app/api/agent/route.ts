import { bindAttachments } from '@/lib/documents/attachments';
import { bindAttachmentToMessage } from '@/lib/documents/attachment-bindings';
import { withApi, requireSession, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgent, agentConfigured, generateCarryover } from '@/lib/agent/loop';
import { loadAgentContext } from '@/lib/agent/context';
import { saveConversation, loadCarryover, loadTranscriptResult, ingestCarryoverFacts } from '@/lib/agent/memory';
import { mintMessageId } from '@/lib/agent/transcript-store';
import { parseMentions } from '@/lib/agent/personas';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';

// POST /api/agent — LeadRail AI conversational executor.
// Body: { message?, brandId?, conversationId?, approve?: { approvalId, tool, args } }
//  - message:        a new user instruction (start or continue a conversation)
//  - approve:        execute a previously-proposed sensitive tool, then continue
//  - conversationId: opaque id WE issued; the server loads the transcript for it
// The client NEVER sends transcript content (Packet 0.2): conversation state is
// server-owned, so a client cannot inject fabricated OBSERVATION lines or fake
// assistant turns into the model's context.
// Account scope is ALWAYS the authenticated session — never the request body.
async function POST__impl(request: NextRequest) {
  const { session, error } = await requireSession(request);
  if (error) return error;

  if (!agentConfigured()) {
    return NextResponse.json(
      { error: 'LeadRail AI is temporarily unavailable', code: 'not_configured' },
      { status: 409 },
    );
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

  // Server-owned conversation state. The transcript is loaded from OUR store,
  // scoped to this session's account — an id belonging to another account (or
  // an unknown one) yields [], never an error and never their data.
  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;
  // Same guard as the streaming twin: a read that FAILED reports [], and
  // running the turn on that would save one message over the whole history.
  // Refuse rather than truncate — see loadTranscriptResult.
  const transcriptResult = await loadTranscriptResult(conversationId, session.accountId);
  if (!transcriptResult.ok && conversationId) {
    return badRequest('Could not load this conversation just now, so nothing was run — your history is safe and untouched. Try again in a moment.');
  }
  const transcript = transcriptResult.messages;

  // Resolve a venture id/name for grounding (best-effort; ownership is still
  // enforced per-tool). Only for brands the session owns.
  let brandId: string | undefined;
  let brandName: string | undefined;
  if (typeof body?.brandId === 'string' && body.brandId) {
    const { data } = await supabase.from('brands')
      .select('id, name').eq('id', body.brandId).eq('account_id', session.accountId).maybeSingle();
    if (data?.id) { brandId = data.id; brandName = data.name || undefined; }
  }
  if (!brandName && typeof body?.brandName === 'string') {
    const n = body.brandName.trim();
    if (n && n.toLowerCase() !== 'all ventures') brandName = n;
  }

  // Carryover reseed: when a fresh chat is opened from a prior one, load its memo.
  const fromId = typeof body?.from === 'string' && body.from ? body.from : undefined;
  const carryover = fromId ? await loadCarryover(fromId, session.accountId) : null;

  // Full grounding block — platform + venture + account snapshot + durable memory.
  // BEFORE the context is assembled, or the prompt is built without them.
  // A file dropped into a new chat uploaded before the chat had an id, so it
  // landed with conversation_id NULL and listAttachments could never see it.
  // The client names the ids it meant; this claims the unbound ones.
  const attachmentIds: string[] = Array.isArray(body?.attachmentIds)
    ? body.attachmentIds.filter((x: unknown) => typeof x === 'string').slice(0, 20)
    : [];
  if (attachmentIds.length && conversationId) {
    await bindAttachments(session.accountId, attachmentIds, conversationId).catch(() => 0);
  }

  const agentContext = await loadAgentContext({ accountId: session.accountId, brandId, brandName, query: message, conversationId, attachmentIds });

  // Optional persona routing (migration 024). Both fields are optional/absent
  // for every existing caller, so this is a no-op unless the client opts in.
  const personaId: string | undefined = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined;
  const personaMentions = parseMentions(message);

  // PLAN MODE. The turn writes a plan and stops instead of executing it, so
  // the operator sees the shape of the work before any of it runs. A request
  // flag, never a model decision: the model must not be able to decide it is
  // allowed to skip the go-ahead.
  const planOnly = body?.planOnly === true;

  // Minted BEFORE the turn runs, not discovered afterwards by scanning the
  // returned transcript for a matching role/content pair — that would be
  // ambiguous the moment someone sends the same message twice. loop.ts's
  // RunAgentInput.userMessageId (if set) is what the push site attaches this
  // id to; saveConversation's ensureMessageIds (migration 076) preserves it
  // verbatim rather than minting a different one. Only for a real new
  // message — an approve-resume has no new user turn to bind anything to.
  const userMessageId = typeof message === 'string' && message.trim() ? mintMessageId() : undefined;

  const result = await runAgent({
    accountId: session.accountId,
    message,
    approve,
    transcript,
    agentContext,
    carryover,
    brandContext: (brandId || brandName) ? { id: brandId, name: brandName } : undefined,
    personaId,
    personaMentions,
    requestedBy: session.email,
    conversationId,
    planOnly,
    userMessageId,
  });
  const savedId = await saveConversation({
    id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
    title: typeof message === 'string' ? message.slice(0, 80) : undefined,
    transcript: result.transcript,
  });

  // Durable, message-level provenance (migration 076) — separate from, and
  // additional to, bindAttachments above (which stamps
  // assistant_attachments.conversation_id and is what loadAgentContext reads
  // to put the file in THIS turn's prompt). This is what survives a reload:
  // a row in attachment_bindings naming exactly which exchange the file was
  // attached to, independent of the transcript content. Best-effort — a
  // binding failure must not fail a turn that otherwise succeeded; the file
  // was still visible to the model via attachmentsByIds/loadAgentContext
  // regardless of whether this durable record is written.
  if (savedId && userMessageId && attachmentIds.length) {
    await Promise.all(attachmentIds.map((attachmentId) =>
      bindAttachmentToMessage(session.accountId, attachmentId, savedId, userMessageId, {
        scope: 'message', role: 'user_upload', boundBy: 'user',
      }).catch((e) => {
        log.error('agent: bindAttachmentToMessage failed', e, { conversationId: savedId, attachmentId, userMessageId });
      }),
    ));
  }

  // Passive memory extraction (Packet 1.1). Gated to a COMPACTION event, not
  // every turn: once per long chat is the right cadence, per-message would
  // flood agent_memory with task chatter. Fire-and-forget — never awaited, so
  // it cannot delay or fail the response; recordFact applies the secret guard.
  if (result.compaction === 'soft' || result.compaction === 'hard') {
    void generateCarryover(result.transcript)
      .then((memo) => ingestCarryoverFacts(session.accountId, memo))
      .catch(() => { /* best-effort */ });
  }

  return NextResponse.json({
    status: result.status,
    message: result.message,
    proposal: result.proposal,
    steps: result.steps,
    transcript: result.transcript,
    conversationId: savedId ?? conversationId,
    tokenEstimate: result.tokenEstimate,
    compaction: result.compaction ?? null,
  });
}

export const POST = withApi(POST__impl as any, { route: '/api/agent', method: 'POST' });
