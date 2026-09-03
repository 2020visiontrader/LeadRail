import { bindAttachments } from '@/lib/documents/attachments';
import { bindAttachmentToMessage } from '@/lib/documents/attachment-bindings';
import { withApi, requireSession, badRequest } from '@/lib/http';
import type { Session } from '@/lib/session';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgent, agentConfigured, generateCarryover } from '@/lib/agent/loop';
import { loadAgentContext } from '@/lib/agent/context';
import { saveConversation, loadCarryover, loadTranscriptResult, ingestCarryoverFacts, markConversationRunning, clearConversationRunning, clearStopRequest } from '@/lib/agent/memory';
import { mintMessageId, ensureMessageIds } from '@/lib/agent/transcript-store';
import { stripPrivateReasoning } from '@/lib/agent/transcript-privacy';
import { parseMentions } from '@/lib/agent/personas';
import { assertSelectableModel } from '@/lib/ai/providers';
import { sanitizeTurnContext, renderTurnContextBlock } from '@/lib/agent/turn-context';
import { log } from '@/lib/logger';

export const dynamic = 'force-dynamic';
// Both were MISSING on this route — see app/api/agent/stream/route.ts's
// identical exports (lines ~19-33) for the full rationale: without an
// explicit `runtime` the platform's default is not guaranteed to be Node, and
// without `maxDuration` above lib/agent/loop.ts's own turn deadline the
// platform can cut the request off before the loop's deadline ever gets a
// chance to fire and hand back a salvaged answer (production observed a turn
// killed at durationMs 300004/300005 on this exact path). Do not lower this
// below, or raise TURN_DEADLINE_MS to meet, the stream route's value — see
// tests/turn-deadline-invariant.test.ts.
export const runtime = 'nodejs';
export const maxDuration = 300;

// CONCURRENCY INSTRUMENTATION — JSON twin of the block in
// app/api/agent/stream/route.ts. Read that comment for the full decision
// rule and the per-process caveat; both apply verbatim here. This is the
// path that actually carries most turns (13 'agent:json' vs 4 'agent:stream'
// in the last 17 production turns as of 2026-08-28), so a measurement that
// only covered the stream route would miss where the block, if any, mostly
// happens. Distinct message strings ("agent json:" vs "agent stream:") so a
// single app_logs query can tell the two paths apart. Persisted through
// log.request(fields, 'info') for the same reason as the stream route:
// log.info() is console-only and would leave this instrumentation as
// unqueryable as the one it was written to replace.
let openRequests = 0;
let requestSeq = 0;

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

  const requestId = `j${++requestSeq}`;
  openRequests += 1;
  // log.request(), not log.info() — see the CONCURRENCY INSTRUMENTATION
  // comment above the counters for why.
  log.request({ message: 'agent json: received', detail: { requestId, openRequests } }, 'info');
  let requestClosed = false;
  const closeRequest = () => {
    if (requestClosed) return;
    requestClosed = true;
    openRequests -= 1;
    log.request({ message: 'agent json: closed', detail: { requestId, openRequests } }, 'info');
  };

  // Everything below is wrapped so the decrement above happens on EVERY exit
  // — the early `badRequest` returns, the normal success return, and a throw
  // — with the same double-decrement guard (`requestClosed`) as the stream
  // route's `closeStream`. A leaked count here would make every later
  // reading of openRequests wrong, which is worse than no counter at all.
  try {
    return await runPost(request, session);
  } finally {
    closeRequest();
  }
}

async function runPost(request: NextRequest, session: Session) {
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

  // Mark this conversation as having a turn in progress (migration 072) — the
  // JSON twin of the block in app/api/agent/stream/route.ts. Only meaningful
  // once an id exists: an approve-resume or an existing chat already has one;
  // a brand-new chat (no conversationId in the request body) has nothing yet
  // for a client to poll GET /api/agent/conversations/[id] against, so there
  // is nothing to mark. markConversationRunning is best-effort and swallows
  // its own errors (lib/agent/memory.ts) — a logging/flag failure must never
  // fail the turn, so this is never wrapped in its own try/catch here.
  //
  // Without this, a reload mid-turn on THIS path (most of production traffic
  // — see the CRITICAL PROCESS RULE note above) shows the saved transcript
  // with no answer, no spinner, and no polling, because GET .../conversations
  // /[id] reports running: false the whole time the turn is actually running.
  //
  // DEFECT B (found in review of bd63b6d): this used to also call
  // clearStopRequest here, at turn start — which raced a user's own
  // "Stop, then immediately send the corrected message" workflow: the NEW
  // turn's route would clear stop_requested_at out from under the OLD turn
  // that was still running, so the old turn's next check saw nothing and ran
  // to completion. isStopRequested (lib/agent/memory.ts) now compares
  // stop_requested_at against running_since instead, which makes a stale stop
  // from a prior turn harmless without needing to clear it here — see that
  // function's doc comment. Not called at turn start any more for that reason.
  if (conversationId) {
    await markConversationRunning(conversationId, session.accountId);
  }

  try {
    return await runTurn(session, { conversationId, transcript, message, approve, body });
  } finally {
    // Cleared UNCONDITIONALLY — success, a badRequest-style early return
    // inside runTurn, or a throw all reach here. A leaked flag is what makes
    // a conversation look permanently busy (RUNNING_STALE_MS, 6 min, is the
    // last-resort backstop for a killed process — not a substitute for
    // clearing this on every normal exit).
    if (conversationId) {
      await clearConversationRunning(conversationId, session.accountId);
      // Turn END is the unambiguously-correct place to clear a stop request
      // (see clearStopRequest's doc comment): whatever turn this stop applied
      // to has already finished, and a next turn hasn't started yet, so there
      // is nothing here for the clear to race against.
      await clearStopRequest(conversationId, session.accountId);
    }
  }
}

async function runTurn(
  session: Session,
  ctx: { conversationId: string | undefined; transcript: any; message: string | undefined; approve: any; body: any },
) {
  const { transcript, message, approve, body } = ctx;
  // `let`, not `const`: the opening save below (mirroring
  // app/api/agent/stream/route.ts) mints an id for a brand-new conversation,
  // and everything after it — agentContext's own conversationId param aside,
  // which intentionally still reads the pre-open value below — must use that
  // minted id rather than undefined.
  let conversationId = ctx.conversationId;

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

  // WHERE THE USER IS. Client-reported {page, selectedIds, filters} — never
  // trusted for scoping (brandId above is the only field here with real
  // authority, and it is already ownership-checked), only rendered as a
  // short, hard-capped block for orientation. sanitizeTurnContext clips every
  // string/list BEFORE it reaches the prompt, so an adversarially long filter
  // value cannot grow the turn's system prompt unbounded.
  const turnContext = renderTurnContextBlock(sanitizeTurnContext(body?.turnContext));

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

  // Composer model dropdown (an ai_models row id). Validated against THIS
  // account's own enabled models before it goes anywhere near the router —
  // a client-supplied id that isn't one of the account's enabled models is
  // silently ignored, never trusted straight through. See RunAgentInput.modelId.
  const requestedModelId: string | undefined = typeof body?.modelId === 'string' && body.modelId ? body.modelId : undefined;
  const modelId = await assertSelectableModel(session.accountId, requestedModelId);

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

  // WHAT THE PERSON SAID IS DURABLE FROM HERE, whatever happens next —
  // mirrors app/api/agent/stream/route.ts's opening save (see its comment).
  // Previously this route only wrote a transcript AFTER runAgent returned, so
  // a turn that errored or ran past the platform's timeout lost the user's
  // own message together with everything else — the production symptom was
  // three consecutive user messages with no assistant reply in between.
  const wasNewConversation = !conversationId;
  if (typeof message === 'string' && message.trim()) {
    const openingTranscript = [
      ...transcript,
      { role: 'user', content: message, ...(userMessageId ? { id: userMessageId } : {}) },
    ];
    const openedId = await saveConversation({
      id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
      title: message.slice(0, 80),
      transcript: openingTranscript,
    }).catch(() => null);
    if (openedId) {
      conversationId = openedId;
      // THE RETRY THIS EXISTS FOR — twin of the stream route's: a brand-new
      // chat has no id yet at the top of this function, so the attachment
      // bind above was skipped rather than done. Now that an id exists, bind
      // against it — but only if the earlier attempt didn't already run (an
      // existing chat that already had conversationId at the top), so a file
      // is never bound twice.
      if (attachmentIds.length && wasNewConversation) {
        await bindAttachments(session.accountId, attachmentIds, openedId).catch(() => 0);
      }
    }
  }

  // Mark this conversation as having a turn in progress (migration 072) —
  // BEFORE runAgent, which is the part that can legitimately take minutes.
  // Twin of the mark in runPost above for a pre-existing conversationId; this
  // one covers the id just minted above for a BRAND-NEW chat, which runPost
  // never had a chance to mark because it didn't exist yet when runPost ran.
  if (wasNewConversation && conversationId) {
    await markConversationRunning(conversationId, session.accountId);
    // No matching clearStopRequest here — see the DEFECT B comment on the
    // mark in runPost above. clearStopRequest is only called at turn END now.
  }

  let result;
  try {
    result = await runAgent({
      accountId: session.accountId,
      message,
      approve,
      transcript,
      agentContext,
      carryover,
      brandContext: (brandId || brandName) ? { id: brandId, name: brandName } : undefined,
      turnContext,
      personaId,
      personaMentions,
      requestedBy: session.email,
      conversationId,
      planOnly,
      userMessageId,
      modelId,
    });
  } finally {
    // Twin of the clear in runPost's own finally, for the id minted above —
    // runPost's clear only ever knew about a conversationId that was already
    // in the request body, so a brand-new chat's freshly-minted id would
    // otherwise never have its running flag (or stop flag) cleared here.
    if (wasNewConversation && conversationId) {
      await clearConversationRunning(conversationId, session.accountId);
      await clearStopRequest(conversationId, session.accountId);
    }
  }
  // Message-action Packet — see the twin comment in
  // app/api/agent/stream/route.ts's `finally` block for why this reads back
  // the id-bearing copy of the transcript rather than trusting
  // result.transcript's ids: saveConversation mints ids internally
  // (migration 076) but never returns that copy, and this response is what
  // the console uses to key a thumbs vote or a retry the moment the turn
  // finishes, without waiting for a reload. ensureMessageIds is pure and
  // idempotent, so calling it here duplicates no minting saveConversation
  // would otherwise do. This copy — and everything derived from it below
  // (the response's `transcript`/`lastMessageId`) — is UNCHANGED by the G8
  // fix just below: only what gets persisted changes, never what goes on
  // the wire.
  const transcriptWithIds = ensureMessageIds(result.transcript);

  // G8 FIX. On `status: 'error'` (a model failure, a deadline or stop with
  // nothing to salvage, an approval that could no longer be recorded, ...)
  // `result.transcript` never includes the error text itself as an assistant
  // entry (mirrors the stream route's runAgentStream events; the two loops
  // stay identical per CLAUDE.md). Persisting it unmodified saved only the
  // user's message with no reply, so a reload showed an unanswered question
  // and the next turn's model saw one too. Persist the id-bearing transcript
  // above PLUS the exact text the client receives as `message` below, unless
  // it already ends with that message (defensive — no runAgent path does
  // this today, but never double-add). A fresh id is minted for the appended
  // entry by re-running ensureMessageIds — it preserves every id already
  // present, so this cannot disturb anything computed from
  // `transcriptWithIds` above.
  let transcriptForSave = transcriptWithIds;
  if (result.status === 'error' && typeof result.message === 'string' && result.message) {
    const last = transcriptForSave.length ? transcriptForSave[transcriptForSave.length - 1] : undefined;
    const alreadyEndsWithError = last && last.role === 'assistant' && last.content === result.message;
    if (!alreadyEndsWithError) {
      transcriptForSave = ensureMessageIds([...transcriptForSave, { role: 'assistant', content: result.message }]);
    }
  }
  const savedId = await saveConversation({
    id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
    title: typeof message === 'string' ? message.slice(0, 80) : undefined,
    transcript: transcriptForSave,
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
    // The CLIENT-BOUND copy: the model's private `plan` removed from every
    // assistant envelope. `transcriptForSave` (unstripped) is what was saved
    // above — `transcriptWithIds` plus the G8 error-message entry when this
    // turn errored — so a later turn still resumes on the full reasoning and
    // sees its own unanswered message answered. See lib/agent/transcript-privacy.ts.
    // Twin of the strip on the stream route's `final`/`needs_approval` events.
    transcript: stripPrivateReasoning(transcriptWithIds),
    conversationId: savedId ?? conversationId,
    tokenEstimate: result.tokenEstimate,
    compaction: result.compaction ?? null,
    userMessageId,
    lastMessageId: transcriptWithIds.length ? transcriptWithIds[transcriptWithIds.length - 1].id : undefined,
    // Migration 080 (message_feedback.skill_slugs): the routed skill slugs
    // for this turn, so the console can pass them back on a feedback vote.
    // See the twin field on the stream route's 'conversation' event.
    skillSlugs: result.skillSlugs,
  });
}

export const POST = withApi(POST__impl as any, { route: '/api/agent', method: 'POST' });
