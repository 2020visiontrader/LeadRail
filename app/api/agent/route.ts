import { withApi, requireSession, badRequest } from '@/lib/http';
import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/db';
import { runAgent, agentConfigured } from '@/lib/agent/loop';
import { loadAgentContext } from '@/lib/agent/context';
import { saveConversation, loadCarryover } from '@/lib/agent/memory';
import { parseMentions } from '@/lib/agent/personas';
import type { ChatMessage } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

// POST /api/agent — LeadRail AI conversational executor.
// Body: { message?, brandId?, transcript?, approve?: { tool, args } }
//  - message:    a new user instruction (start or continue a conversation)
//  - approve:    execute a previously-proposed sensitive tool, then continue
//  - transcript: prior model transcript returned by a needs_approval result
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

  const transcript: ChatMessage[] = Array.isArray(body?.transcript)
    ? body.transcript.filter((m: any) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    : [];

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
  const agentContext = await loadAgentContext({ accountId: session.accountId, brandId, brandName, query: message });

  // Optional persona routing (migration 024). Both fields are optional/absent
  // for every existing caller, so this is a no-op unless the client opts in.
  const personaId: string | undefined = typeof body?.personaId === 'string' && body.personaId ? body.personaId : undefined;
  const personaMentions = parseMentions(message);

  // Persist the conversation (best-effort; never blocks the response).
  const conversationId = typeof body?.conversationId === 'string' && body.conversationId ? body.conversationId : undefined;

  const result = await runAgent({
    accountId: session.accountId,
    message,
    approve,
    transcript,
    agentContext,
    carryover,
    brandContext: brandName ? { name: brandName } : undefined,
    personaId,
    personaMentions,
    requestedBy: session.email,
    conversationId,
  });
  const savedId = await saveConversation({
    id: conversationId, accountId: session.accountId, brandId: brandId ?? null,
    title: typeof message === 'string' ? message.slice(0, 80) : undefined,
    transcript: result.transcript,
  });

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
